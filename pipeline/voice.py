"""ElevenLabs text-to-speech with word-level timestamps.

The /with-timestamps endpoint returns the audio plus per-character timings; we
fold those into word timings so the read-along teleprompter can highlight in
sync. The voice id comes from settings (voice.elevenlabs_voice_id) or the
account's first available voice. Only ELEVENLABS_API_KEY comes from the
environment.
"""
from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from pathlib import Path

from pipeline import config, store

ELEVEN_BASE = "https://api.elevenlabs.io/v1"
DEFAULT_MODEL = "eleven_turbo_v2_5"

totals = {"characters": 0}


def _key() -> str:
    key = config.env("ELEVENLABS_API_KEY")
    if not key:
        raise RuntimeError("ELEVENLABS_API_KEY is not set. Add it to .env.local to run voice stages.")
    return key


def _first_voice_id() -> str:
    req = urllib.request.Request(f"{ELEVEN_BASE}/voices", headers={"xi-api-key": _key()})
    with urllib.request.urlopen(req, timeout=30) as resp:
        voices = json.loads(resp.read().decode("utf-8")).get("voices", [])
    if not voices:
        raise RuntimeError("No ElevenLabs voices available on this account")
    return voices[0]["voice_id"]


def voice_id() -> str:
    return store.get_setting("voice.elevenlabs_voice_id") or _first_voice_id()


def _chars_to_words(alignment: dict) -> list[dict]:
    chars = alignment.get("characters", [])
    starts = alignment.get("character_start_times_seconds", [])
    ends = alignment.get("character_end_times_seconds", [])
    words: list[dict] = []
    cur = ""
    w_start = 0.0
    for i, ch in enumerate(chars):
        if ch.isspace():
            if cur:
                words.append({"word": cur, "start": w_start, "end": ends[i - 1] if i > 0 else w_start})
                cur = ""
            continue
        if not cur:
            w_start = starts[i] if i < len(starts) else 0.0
        cur += ch
    if cur:
        words.append({"word": cur, "start": w_start, "end": ends[-1] if ends else w_start})
    return words


def synthesize(text: str, dest_audio: Path) -> dict:
    """Render narration to dest_audio (mp3) and return word-level timings."""
    body = json.dumps({"text": text, "model_id": DEFAULT_MODEL}).encode("utf-8")
    req = urllib.request.Request(
        f"{ELEVEN_BASE}/text-to-speech/{voice_id()}/with-timestamps",
        data=body,
        headers={"xi-api-key": _key(), "Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"ElevenLabs HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:200]}") from e

    audio_b64 = data.get("audio_base64") or data.get("audio")
    if not audio_b64:
        raise RuntimeError(f"ElevenLabs returned no audio: {str(data)[:200]}")
    dest_audio.parent.mkdir(parents=True, exist_ok=True)
    dest_audio.write_bytes(base64.b64decode(audio_b64))

    alignment = data.get("alignment") or data.get("normalized_alignment") or {}
    totals["characters"] += len(text)
    return {"audio": str(dest_audio), "words": _chars_to_words(alignment)}
