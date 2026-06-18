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

# Gemini-TTS goes through the SAME text:synthesize endpoint with voice.model_name set
# to one of these values. Voices are the same 28 prebuilt names as Chirp 3 HD (Aoede,
# Charon, Kore, ...) but Gemini expects the BARE name, not the locale-prefixed form.
# Limits per Google's gemini-tts docs: text field <= 4000 bytes, prompt field <= 4000
# bytes, combined <= 8000 bytes. Our articles top out around 2500 chars so a single
# sync request handles the whole narration without chunking.
GEMINI_TIER_TO_MODEL_NAME = {
    "gemini-25-flash-tts": "gemini-2.5-flash-tts",
    "gemini-31-flash-tts": "gemini-3.1-flash-tts-preview",
}
GEMINI_TEXT_BYTE_LIMIT = 4000
GEMINI_PROMPT_BYTE_LIMIT = 4000
GEMINI_COMBINED_BYTE_LIMIT = 8000

# Process-level totals for cost metering. Per-provider so the run-end summary
# can attribute spend without ambiguity.
totals = {
    "elevenlabs_characters": 0,
    "google_tts_characters": 0,
    "google_stt_seconds": 0.0,
}


# --- public API ---------------------------------------------------------------

def synthesize(
    text: str,
    dest_audio: Path,
    override_provider: str | None = None,
    override_voice_id: str | None = None,
) -> dict:
    """Render narration to `dest_audio` and return word-level timings.

    Returns `{"audio": str, "words": [{"word", "start", "end"}, ...], "provider": str}`.

    Resolution chain (Phase 1 of `_plans/2026-06-14-voiceover-picker.md`):
      1. `override_provider` (caller-supplied per-story override) wins.
      2. Otherwise the active model selection from `models.get_selected("voice")`.
    And independently for the voice id WITHIN the resolved provider:
      1. `override_voice_id` wins.
      2. Otherwise the admin's global setting for that provider
         (`voice.elevenlabs_voice_id` / `voice.google_voice_name`).
      3. Otherwise the provider's first-voice fallback (legacy behaviour).

    Both override args independently default to None so existing callers
    (fresh-pipeline path) keep the global-setting behaviour byte-for-byte.
    The Phase 4 regen action threads per-story values through here.
    """
    selected = override_provider or models.get_selected("voice")
    provider, _, _tier = selected.partition("/")
    print(
        f"[voice resolve] provider={selected} "
        f"voice_id_override={override_voice_id or '<none>'} "
        f"source={'story-override' if override_provider else 'global'}"
    )
    if provider == "google":
        return _google_synthesize(
            text, dest_audio, selected,
            voice_id_override=override_voice_id,
        )
    if provider == "elevenlabs":
        return _elevenlabs_synthesize(
            text, dest_audio, voice_id_override=override_voice_id,
        )
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


def _elevenlabs_voice_id(override: str | None = None) -> str:
    """Resolve the ElevenLabs voice id to use.

    Phase 1 override chain: caller-supplied `override` wins, then the
    admin setting `voice.elevenlabs_voice_id`, then the first voice on
    the account (legacy fallback — preserved so a fresh account with no
    setting still ships audio).
    """
    if override:
        return override
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


def _elevenlabs_synthesize(
    text: str, dest_audio: Path, voice_id_override: str | None = None,
) -> dict:
    body = json.dumps({"text": text, "model_id": ELEVEN_DEFAULT_MODEL}).encode("utf-8")
    req = urllib.request.Request(
        f"{ELEVEN_BASE}/text-to-speech/{_elevenlabs_voice_id(voice_id_override)}/with-timestamps",
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
    # Gemini-TTS expects bare voice names (see _gemini_voice_name).
    "gemini-25-flash-tts": "en-US-Chirp3-HD-Aoede",
    "gemini-31-flash-tts": "en-US-Chirp3-HD-Aoede",
}


def _google_tier(selected: str) -> str:
    """Return the Google tier suffix from a selected model id like 'google/chirp3-hd'."""
    _, _, tier = selected.partition("/")
    if not tier:
        raise RuntimeError(f"Google voice selection {selected!r} is missing a tier suffix.")
    return tier


def _is_gemini_tier(tier: str) -> bool:
    return tier in GEMINI_TIER_TO_MODEL_NAME


def _google_voice_name(selected: str, override: str | None = None) -> str:
    """Resolve the full Google voice name (e.g. en-US-Chirp3-HD-Aoede).

    Phase 1 override chain: caller-supplied `override` wins, then the
    admin setting `voice.google_voice_name`, then the tier's default.
    Caller is expected to be on a Google selection.
    """
    if override:
        return override
    setting = (store.get_setting("voice.google_voice_name") or "").strip()
    if setting:
        return setting
    tier = _google_tier(selected)
    return _GOOGLE_TIER_FALLBACK_VOICE.get(tier, GOOGLE_DEFAULT_VOICE)


def _gemini_voice_name(voice_name: str) -> str:
    """Strip the locale + Chirp3-HD prefix so a setting like
    'en-US-Chirp3-HD-Aoede' becomes 'Aoede' — the bare form Gemini-TTS expects.

    Passing the full Chirp name to Gemini returns
    'Gemini models cannot be used with non-Gemini voices.' (yt-studio note,
    see _reference/youtubestudio/src/lib/tts/providers/google.ts). Falls
    through to the raw value when the pattern doesn't match so an admin who
    sets a bare name directly still works.
    """
    import re
    match = re.search(r"Chirp3-HD-(.+)$", voice_name, re.IGNORECASE)
    return match.group(1) if match else voice_name


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


def _google_synthesize(
    text: str,
    dest_audio: Path,
    selected: str,
    voice_id_override: str | None = None,
) -> dict:
    voice_name_setting = _google_voice_name(selected, voice_id_override)
    language_code = _google_language_code(voice_name_setting)
    tier = _google_tier(selected)

    if _is_gemini_tier(tier):
        payload = _build_gemini_payload(text, voice_name_setting, language_code, tier)
        billed_chars = payload["_billed_chars"]
        payload.pop("_billed_chars")
    else:
        # Google's synchronous text:synthesize endpoint accepts up to 5000 bytes for
        # non-Gemini voices. Our articles top out around 2500 chars (~2.5 KB ASCII),
        # so we render in one call and let the LLM rewrite keep us under the ceiling.
        payload = {
            "input": {"text": text},
            "voice": {"languageCode": language_code, "name": voice_name_setting},
            "audioConfig": {"audioEncoding": "MP3"},
        }
        billed_chars = len(text)

    data = _google_post(GOOGLE_TTS_URL, payload)
    audio_b64 = data.get("audioContent")
    if not audio_b64:
        raise RuntimeError(f"Google TTS returned no audioContent: {str(data)[:200]}")
    dest_audio.parent.mkdir(parents=True, exist_ok=True)
    audio_bytes = base64.b64decode(audio_b64)
    dest_audio.write_bytes(audio_bytes)
    totals["google_tts_characters"] += billed_chars

    # Google does not return word timings with synthesis. Run STT on the
    # generated audio with enableWordTimeOffsets to recover them.
    words = _google_align(audio_bytes, language_code)

    return {"audio": str(dest_audio), "words": words, "provider": "google"}


def _build_gemini_payload(
    text: str, voice_name_setting: str, language_code: str, tier: str
) -> dict:
    """Construct the synth payload for a Gemini-TTS request.

    Three Gemini quirks the regular path doesn't have:
      1. The voice.name field must be the BARE form ("Aoede"), not the
         locale-prefixed Chirp 3 HD form ("en-US-Chirp3-HD-Aoede"). Google
         rejects the prefixed form with "Gemini models cannot be used with
         non-Gemini voices."
      2. voice.modelName carries the specific Gemini variant
         (gemini-2.5-flash-tts or gemini-3.1-flash-tts-preview).
      3. An optional style instruction lives at `input.prompt`. Total
         (text + prompt) cannot exceed 8000 bytes and each field is capped
         at 4000 bytes. Both fields count toward billing.

    The function attaches a `_billed_chars` key the caller pops before
    POSTing — it's the combined char count that drives cost tracking.
    """
    style_prompt = (store.get_setting("voice.google_style_prompt") or "").strip()
    text_bytes = len(text.encode("utf-8"))
    prompt_bytes = len(style_prompt.encode("utf-8")) if style_prompt else 0
    if text_bytes > GEMINI_TEXT_BYTE_LIMIT:
        raise RuntimeError(
            f"Gemini-TTS text exceeds {GEMINI_TEXT_BYTE_LIMIT}-byte cap "
            f"({text_bytes} bytes). Shorten the narration or chunk client-side."
        )
    if prompt_bytes > GEMINI_PROMPT_BYTE_LIMIT:
        raise RuntimeError(
            f"voice.google_style_prompt exceeds {GEMINI_PROMPT_BYTE_LIMIT}-byte cap "
            f"({prompt_bytes} bytes). Tighten the style instruction."
        )
    if text_bytes + prompt_bytes > GEMINI_COMBINED_BYTE_LIMIT:
        raise RuntimeError(
            f"Gemini-TTS combined text + prompt exceeds {GEMINI_COMBINED_BYTE_LIMIT}-byte cap "
            f"(text={text_bytes}, prompt={prompt_bytes})."
        )

    voice_input = {"text": text}
    if style_prompt:
        voice_input["prompt"] = style_prompt

    voice_obj = {
        "languageCode": language_code,
        "name": _gemini_voice_name(voice_name_setting),
        "modelName": GEMINI_TIER_TO_MODEL_NAME[tier],
    }
    return {
        "input": voice_input,
        "voice": voice_obj,
        "audioConfig": {"audioEncoding": "MP3"},
        "_billed_chars": len(text) + len(style_prompt),
    }


def _google_align(audio_bytes: bytes, language_code: str) -> list[dict]:
    """Recognize the TTS audio with word-level offsets and return word timings.

    Two hardening tricks on this path:
      1. Pin `sampleRateHertz: 24000`. Google TTS outputs at 24 kHz for every
         tier we expose (Chirp HD, Gemini, Neural2, Standard). Without the pin,
         STT mis-detected the rate on Gemini-TTS MP3 (verified 2026-06-11) and
         returned timings stretched ~1.5x past the real audio duration —
         which then drove the video composition to play 60 s past the end of
         the narration.
      2. After collecting word offsets, scale them to the audio file's real
         duration when STT's last-word-end disagrees by >5%. Defense against
         any future format quirk (or a tier we add later) producing the same
         off-by-N issue without us noticing until a video looks wrong.
    """
    payload = {
        "config": {
            "encoding": "MP3",
            "sampleRateHertz": 24000,
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

    words = _calibrate_to_audio_duration(words, audio_bytes)
    if words:
        totals["google_stt_seconds"] += words[-1]["end"]
    return words


def _calibrate_to_audio_duration(words: list[dict], audio_bytes: bytes) -> list[dict]:
    """Scale every word timing to the real MP3 duration when STT drifts >5%.

    Returns the original list unchanged when the durations agree or when the
    audio can't be probed (we'd rather ship slightly off timings than block).
    """
    if not words:
        return words
    true_seconds = _probe_mp3_duration(audio_bytes)
    if true_seconds <= 0:
        return words
    stt_seconds = words[-1]["end"]
    if stt_seconds <= 0:
        return words
    ratio = true_seconds / stt_seconds
    if abs(1.0 - ratio) <= 0.05:
        return words
    print(
        f"[voice align] STT drift detected: true audio={true_seconds:.2f}s, "
        f"STT last word end={stt_seconds:.2f}s; scaling timings by {ratio:.3f}"
    )
    return [
        {"word": w["word"], "start": w["start"] * ratio, "end": w["end"] * ratio}
        for w in words
    ]


def _probe_mp3_duration(mp3_bytes: bytes) -> float:
    """Compute the duration of a Google-TTS MP3 (MPEG-2 Layer III, 24 kHz mono)
    by counting frames in the byte stream. Pure stdlib, no ffmpeg/ffprobe.

    MPEG audio frames start with the 11-bit sync word `0xFFE`. For MPEG-2 Layer
    III each frame is exactly 576 samples; at 24 kHz mono that's 24 ms per
    frame. We scan once, count frames, and return seconds. Returns 0.0 on any
    failure so the caller can fall back to STT's reported duration cleanly.
    """
    SAMPLES_PER_FRAME = 576
    SAMPLE_RATE = 24000
    # MPEG-2 Layer III bitrate table (kbps) indexed by the 4-bit bitrate field.
    BITRATE_TABLE = [None, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, None]
    try:
        frames = 0
        i = 0
        n = len(mp3_bytes)
        while i < n - 4:
            if mp3_bytes[i] != 0xFF or (mp3_bytes[i + 1] & 0xE0) != 0xE0:
                i += 1
                continue
            bitrate_idx = (mp3_bytes[i + 2] >> 4) & 0x0F
            bitrate_kbps = BITRATE_TABLE[bitrate_idx]
            if bitrate_kbps is None:
                i += 1
                continue
            padding = (mp3_bytes[i + 2] >> 1) & 0x01
            # Frame size formula for MPEG-2 Layer III, single channel.
            frame_size = (72 * bitrate_kbps * 1000) // SAMPLE_RATE + padding
            if frame_size <= 0:
                i += 1
                continue
            frames += 1
            i += frame_size
        return frames * SAMPLES_PER_FRAME / SAMPLE_RATE if frames > 0 else 0.0
    except Exception:
        return 0.0


# MPEG audio frame tables for a general, pure-stdlib MP3 duration probe (no
# ffmpeg/ffprobe, so it runs inside the Vercel drain). Unlike
# _probe_mp3_duration above (hard-wired to Google's 24 kHz mono MPEG-2 Layer
# III), this reads version + sample rate + bitrate off every frame header, so
# it is correct for ElevenLabs (MPEG-1, 44.1 kHz) as well as Google.
_MPEG_VERSION = {0b00: "2.5", 0b10: "2", 0b11: "1"}   # 0b01 is reserved
_MPEG_LAYER = {0b01: 3, 0b10: 2, 0b11: 1}             # 0b00 is reserved
_MP3_SAMPLE_RATES = {
    "1": [44100, 48000, 32000, None],
    "2": [22050, 24000, 16000, None],
    "2.5": [11025, 12000, 8000, None],
}
# Bitrate (kbps) indexed by the 4-bit field. Keyed by (version_group, layer)
# where version_group is "1" for MPEG-1 and "2" for MPEG-2 / 2.5 (they share
# the lower-rate tables).
_MP3_BITRATES = {
    ("1", 1): [None, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, None],
    ("1", 2): [None, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, None],
    ("1", 3): [None, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, None],
    ("2", 1): [None, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, None],
    ("2", 2): [None, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, None],
    ("2", 3): [None, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, None],
}
_MP3_SAMPLES_PER_FRAME = {
    ("1", 1): 384, ("1", 2): 1152, ("1", 3): 1152,
    ("2", 1): 384, ("2", 2): 1152, ("2", 3): 576,
    ("2.5", 1): 384, ("2.5", 2): 1152, ("2.5", 3): 576,
}


def audio_duration_ms(path) -> int:
    """Real duration of a synthesized MP3 in milliseconds, summed from the MPEG
    frame headers. Pure stdlib so it runs in the Vercel Python drain (no
    ffprobe). Handles MPEG-1/2/2.5 across all three layers, so it is correct for
    every TTS provider we use. Returns 0 on any failure so callers fall back to
    their caption-derived duration cleanly.

    Shorts use this as the FLOOR for the composition length: the rendered body
    must be at least as long as the narration, or the concatenated outro clips
    the closing words (the last-caption end_ms can undershoot the real audio).
    """
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError:
        return 0
    total_seconds = 0.0
    i = 0
    n = len(data)
    while i < n - 4:
        # 11-bit frame sync (0xFFE) marks a frame header.
        if data[i] != 0xFF or (data[i + 1] & 0xE0) != 0xE0:
            i += 1
            continue
        version = _MPEG_VERSION.get((data[i + 1] >> 3) & 0b11)
        layer = _MPEG_LAYER.get((data[i + 1] >> 1) & 0b11)
        if version is None or layer is None:
            i += 1
            continue
        vgroup = "1" if version == "1" else "2"
        bitrate_idx = (data[i + 2] >> 4) & 0x0F
        srate_idx = (data[i + 2] >> 2) & 0b11
        padding = (data[i + 2] >> 1) & 0x01
        bitrate_kbps = _MP3_BITRATES.get((vgroup, layer), [None] * 16)[bitrate_idx]
        sample_rate = _MP3_SAMPLE_RATES[version][srate_idx]
        if not bitrate_kbps or not sample_rate:
            i += 1
            continue
        if layer == 1:
            frame_size = (12 * bitrate_kbps * 1000 // sample_rate + padding) * 4
        else:
            # Layer II always 144; Layer III is 144 on MPEG-1, 72 on MPEG-2/2.5.
            coeff = 72 if (layer == 3 and version != "1") else 144
            frame_size = coeff * bitrate_kbps * 1000 // sample_rate + padding
        if frame_size <= 0:
            i += 1
            continue
        total_seconds += _MP3_SAMPLES_PER_FRAME[(version, layer)] / sample_rate
        i += frame_size
    return int(round(total_seconds * 1000))


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
