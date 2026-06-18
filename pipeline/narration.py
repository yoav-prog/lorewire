"""High-level narration orchestrator: script -> audio + caption-ready words.

Every narration render in the pipeline needs the same three steps run in
the same order:

  1. `text_normalize.normalize_for_tts(script)` — expand "$1,000,000",
     "Dr. Smith", "1985" etc. into spoken form so the voice and the
     captions share a single surface text.
  2. `voice.synthesize(spoken_script, dest)` — render the audio and
     collect provider-supplied word-level timings.
  3. `captions.align_script_to_words(spoken_script, words, provider)` —
     graft the spoken-script tokens onto the timing array so the
     caption text is correct (no STT homophones, no missing
     punctuation, no dropped or inserted words).

Calling these individually risks skipping one — and a missed normalize
or graft step puts homophones back into the captions. This module is
the single public entry point so every code path that produces voice
audio goes through the same fix.

Background: _plans/2026-06-18-caption-accuracy-and-naturalness.md.
"""
from __future__ import annotations

from pathlib import Path

from pipeline import captions, text_normalize, voice


def render_narration(
    script: str,
    dest_audio: Path,
    override_provider: str | None = None,
    override_voice_id: str | None = None,
) -> dict:
    """Render `script` to audio and return caption-ready word timings.

    Returns:
        ``{
            "audio": str,
            "words": [{"word", "start", "end"}, ...],
            "provider": str,
            "spoken_script": str,
        }``

    `words` is the script-grafted timing array (each `.word` is a token
    from the normalized source script; timings are from the provider).
    `spoken_script` is the normalized form actually fed to TTS — callers
    that track cost or write the rendered text to the DB should prefer
    this over the raw input.
    """
    spoken_script = text_normalize.normalize_for_tts(script)
    result = voice.synthesize(
        spoken_script,
        dest_audio,
        override_provider=override_provider,
        override_voice_id=override_voice_id,
    )
    words = captions.align_script_to_words(
        spoken_script,
        result.get("words", []),
        result.get("provider", ""),
    )
    return {
        "audio": result.get("audio"),
        "words": words,
        "provider": result.get("provider"),
        "spoken_script": spoken_script,
    }
