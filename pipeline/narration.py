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

import re
from pathlib import Path

from pipeline import captions, text_normalize, voice


def _pause_markup_for(provider: str | None) -> tuple[str, bool]:
    """Resolve the hook-pause tag for a TTS provider as (tag, use_markup_field).

    The two Google generations take pauses differently (verified against Google
    docs 2026):
      - Gemini-TTS: `[long pause]` inline in input.text -> (tag, False).
      - Chirp 3 HD: `[pause long]` in the input.markup field -> (tag, True).
      - Anything else (ElevenLabs, unknown): no pause tag -> ("", False).

    Both are AI-timed beats (~1s), not a fixed millisecond pause; Google exposes
    no exact-duration pause for either generation.
    """
    p = (provider or "").lower()
    if "gemini" in p:
        return ("[long pause]", False)
    if "chirp3-hd" in p:
        return ("[pause long]", True)
    return ("", False)


def render_narration(
    script: str,
    dest_audio: Path,
    override_provider: str | None = None,
    override_voice_id: str | None = None,
    *,
    speaking_rate: float | None = None,
    hook_pause: bool = False,
    hook_text: str | None = None,
    style_prompt: str | None = None,
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

    Shorts voice codification:
      - `style_prompt` is the Gemini-TTS delivery instruction (lively young
        creator, etc.). Ignored on non-Gemini paths.
      - `speaking_rate` sets the Chirp 3 HD pace (1.2 = 20% faster); no-op on
        the Gemini path (Gemini pace rides in the style prompt).
      - `hook_pause` inserts a beat after the cold-open hook so the climax lands
        before the rewind. The tag + field are provider-aware (see
        `_pause_markup_for`). `hook_text` locates the boundary (it is beat 1, the
        script's prefix); a missing/blank hook falls back to the first sentence.

    Because the word timings come from running STT on the FINAL audio, both the
    speed-up and the pause are reflected in the captions automatically — no
    timing math here. Captions are grafted against the clean script, while the
    TTS engine receives the markup-decorated form, so the pause tag never shows
    up as a caption word.
    """
    spoken_script = text_normalize.normalize_for_tts(script)
    tts_input = spoken_script
    use_markup = False
    if hook_pause:
        tag, use_markup_field = _pause_markup_for(override_provider)
        if tag:
            tts_input = _inject_hook_pause(spoken_script, hook_text or "", tag)
            use_markup = use_markup_field and tts_input != spoken_script
    result = voice.synthesize(
        tts_input,
        dest_audio,
        override_provider=override_provider,
        override_voice_id=override_voice_id,
        speaking_rate=speaking_rate,
        use_markup=use_markup,
        style_prompt=style_prompt,
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


def _inject_hook_pause(spoken_script: str, hook: str, tag: str) -> str:
    """Return `spoken_script` with `tag` placed after the cold-open hook.

    The hook is beat 1, so it is the script's prefix; we normalize it the same
    way and match it case-insensitively. When the prefix does not line up (an
    admin-edited script, say) we fall back to the first sentence break, and when
    neither is found we return the text unchanged — a missing beat never blocks
    a render. Assumes a bracket-free script (brand safety bans `[...]` in the
    VO), so the only markup the engine sees is our tag.
    """
    spoken = spoken_script.strip()
    hook_spoken = text_normalize.normalize_for_tts(hook or "").strip()
    if hook_spoken and spoken.lower().startswith(hook_spoken.lower()):
        cut = len(hook_spoken)
        return f"{spoken[:cut]} {tag} {spoken[cut:].lstrip()}".strip()
    sentence = re.search(r"[.!?]", spoken)
    if sentence:
        cut = sentence.end()
        return f"{spoken[:cut]} {tag} {spoken[cut:].lstrip()}".strip()
    return spoken
