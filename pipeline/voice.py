"""Text-to-speech with word-level timings.

Dispatcher: the active model selection (`models.get_selected("voice")`) decides
whether ElevenLabs or Google Cloud Text-to-Speech renders the narration. Both
providers return the same shape so the rest of the pipeline does not branch.

ElevenLabs ships character-level timings with the audio; Google does not, so the
Google path runs Cloud Speech-to-Text on its own output with `enableWordTimeOffsets`
turned on (the same pattern as yt-studio). Cost: $0.024/min audio extra, which
on a typical 2-3 min article is sub-cent.

API keys live in the environment. Voice selection (which specific voice within
the provider) lives in the admin settings (`voice.google_voice_name`,
`voice.elevenlabs_voice_id`).
"""
from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from pathlib import Path

from pipeline import config, google_auth, models, store

ELEVEN_BASE = "https://api.elevenlabs.io/v1"
ELEVEN_DEFAULT_MODEL = "eleven_turbo_v2_5"
GOOGLE_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize"
GOOGLE_STT_URL = "https://speech.googleapis.com/v1/speech:recognize"
GOOGLE_DEFAULT_VOICE = "en-US-Chirp3-HD-Aoede"
GOOGLE_DEFAULT_LANGUAGE = "en-US"

# Process-level totals for cost metering. Per-provider so the run-end summary
# can attribute spend without ambiguity.
totals = {
    "elevenlabs_characters": 0,
    "google_tts_characters": 0,
    "google_stt_seconds": 0.0,
}


# --- public API ---------------------------------------------------------------

def synthesize(text: str, dest_audio: Path) -> dict:
    """Render narration to `dest_audio` and return word-level timings.

    Returns `{"audio": str, "words": [{"word", "start", "end"}, ...], "provider": str}`.
    The provider is decided by `models.get_selected("voice")`.
    """
    selected = models.get_selected("voice")  # e.g. "google/chirp3-hd"
    provider, _, _tier = selected.partition("/")
    if provider == "google":
        return _google_synthesize(text, dest_audio, selected)
    if provider == "elevenlabs":
        return _elevenlabs_synthesize(text, dest_audio)
    raise NotImplementedError(
        f"voice provider {provider!r} (model {selected!r}) is in the registry but not wired."
    )


# --- ElevenLabs ---------------------------------------------------------------

def _elevenlabs_key() -> str:
    key = config.env("ELEVENLABS_API_KEY")
    if not key:
        raise RuntimeError("ELEVENLABS_API_KEY is not set. Add it to .env.local to use ElevenLabs.")
    return key


def _elevenlabs_first_voice_id() -> str:
    req = urllib.request.Request(f"{ELEVEN_BASE}/voices", headers={"xi-api-key": _elevenlabs_key()})
    with urllib.request.urlopen(req, timeout=30) as resp:
        voices = json.loads(resp.read().decode("utf-8")).get("voices", [])
    if not voices:
        raise RuntimeError("No ElevenLabs voices available on this account")
    return voices[0]["voice_id"]


def _elevenlabs_voice_id() -> str:
    return store.get_setting("voice.elevenlabs_voice_id") or _elevenlabs_first_voice_id()


def _chars_to_words(alignment: dict) -> list[dict]:
    """Fold ElevenLabs' character-level alignment into word-level [{word,start,end}]."""
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


def _elevenlabs_synthesize(text: str, dest_audio: Path) -> dict:
    body = json.dumps({"text": text, "model_id": ELEVEN_DEFAULT_MODEL}).encode("utf-8")
    req = urllib.request.Request(
        f"{ELEVEN_BASE}/text-to-speech/{_elevenlabs_voice_id()}/with-timestamps",
        data=body,
        headers={
            "xi-api-key": _elevenlabs_key(),
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"ElevenLabs HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:200]}") from e

    audio_b64 = data.get("audio_base64") or data.get("audio")
    if not audio_b64:
        raise RuntimeError(f"ElevenLabs returned no audio: {str(data)[:200]}")
    dest_audio.parent.mkdir(parents=True, exist_ok=True)
    dest_audio.write_bytes(base64.b64decode(audio_b64))

    alignment = data.get("alignment") or data.get("normalized_alignment") or {}
    totals["elevenlabs_characters"] += len(text)
    return {"audio": str(dest_audio), "words": _chars_to_words(alignment), "provider": "elevenlabs"}


# --- Google Cloud (TTS + STT alignment) --------------------------------------

# Google groups voices by name prefix. The selected model id picks the tier;
# the specific voice name (e.g. en-US-Chirp3-HD-Aoede) lives in settings.
_GOOGLE_TIER_FALLBACK_VOICE = {
    "chirp3-hd": "en-US-Chirp3-HD-Aoede",
    "neural2": "en-US-Neural2-F",
    "standard": "en-US-Standard-F",
}


def _google_tier(selected: str) -> str:
    """Return the Google tier suffix from a selected model id like 'google/chirp3-hd'."""
    _, _, tier = selected.partition("/")
    if not tier:
        raise RuntimeError(f"Google voice selection {selected!r} is missing a tier suffix.")
    return tier


def _google_voice_name(selected: str) -> str:
    """Resolve the full Google voice name (e.g. en-US-Chirp3-HD-Aoede).

    Order: admin setting 'voice.google_voice_name' wins; otherwise the tier's
    default. Caller is expected to be on a Google selection.
    """
    setting = (store.get_setting("voice.google_voice_name") or "").strip()
    if setting:
        return setting
    tier = _google_tier(selected)
    return _GOOGLE_TIER_FALLBACK_VOICE.get(tier, GOOGLE_DEFAULT_VOICE)


def _google_language_code(voice_name: str) -> str:
    # Google voice names are locale-prefixed (e.g. "en-US-Chirp3-HD-Aoede").
    parts = voice_name.split("-")
    return f"{parts[0]}-{parts[1]}" if len(parts) >= 2 else GOOGLE_DEFAULT_LANGUAGE


def _google_post(url: str, body: dict, timeout: int = 180) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {google_auth.access_token()}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:300]
        raise RuntimeError(f"Google HTTP {e.code} ({url.split('/')[-1]}): {detail}") from e


def _google_synthesize(text: str, dest_audio: Path, selected: str) -> dict:
    voice_name = _google_voice_name(selected)
    language_code = _google_language_code(voice_name)

    # Google's synchronous text:synthesize endpoint accepts up to 5000 bytes.
    # Our articles top out around 2500 chars (~2.5 KB ASCII), so we render in
    # one call and let the LLM rewrite keep us under the ceiling.
    payload = {
        "input": {"text": text},
        "voice": {"languageCode": language_code, "name": voice_name},
        "audioConfig": {"audioEncoding": "MP3"},
    }
    data = _google_post(GOOGLE_TTS_URL, payload)
    audio_b64 = data.get("audioContent")
    if not audio_b64:
        raise RuntimeError(f"Google TTS returned no audioContent: {str(data)[:200]}")
    dest_audio.parent.mkdir(parents=True, exist_ok=True)
    audio_bytes = base64.b64decode(audio_b64)
    dest_audio.write_bytes(audio_bytes)
    totals["google_tts_characters"] += len(text)

    # Google does not return word timings with synthesis. Run STT on the
    # generated audio with enableWordTimeOffsets to recover them.
    words = _google_align(audio_bytes, language_code)

    return {"audio": str(dest_audio), "words": words, "provider": "google"}


def _google_align(audio_bytes: bytes, language_code: str) -> list[dict]:
    """Recognize the TTS audio with word-level offsets and return word timings."""
    payload = {
        "config": {
            "encoding": "MP3",
            "languageCode": language_code,
            "enableWordTimeOffsets": True,
            # latest_long is tuned for narration-length audio; better word-time
            # accuracy than the default for content over a few seconds.
            "model": "latest_long",
        },
        "audio": {"content": base64.b64encode(audio_bytes).decode("ascii")},
    }
    data = _google_post(GOOGLE_STT_URL, payload, timeout=120)
    words: list[dict] = []
    for result in data.get("results", []):
        alts = result.get("alternatives", [])
        if not alts:
            continue
        for w in alts[0].get("words", []):
            words.append(
                {
                    "word": w.get("word", ""),
                    "start": _parse_google_duration(w.get("startTime")),
                    "end": _parse_google_duration(w.get("endTime")),
                }
            )
    if words:
        totals["google_stt_seconds"] += words[-1]["end"]
    return words


def _parse_google_duration(value) -> float:
    """Google REST returns durations as strings like '1.500s' (proto Duration)."""
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if s.endswith("s"):
        s = s[:-1]
    try:
        return float(s)
    except ValueError:
        return 0.0
