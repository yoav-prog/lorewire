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

from pipeline import captions, mp3_silence, text_normalize, voice


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


def render_hook_first_narration(
    script: str,
    dest_audio: Path,
    override_provider: str | None = None,
    override_voice_id: str | None = None,
    *,
    hook: str,
    speaking_rate: float | None = None,
    style_prompt: str | None = None,
) -> dict | None:
    """Two-clip narration with a MEASURED hook boundary — the permanent fix for
    the hook-first splice clipping the cold open
    (_plans/2026-07-02-hook-clip-measured-boundary.md).

    The hook line and the rest of the script are synthesized as SEPARATE TTS
    calls (same voice / style), then byte-concatenated into `dest_audio` with a
    pre-encoded silence buffer between them:

        [hook clip][~300ms silence][rest clip]

    So "where does the hook end" stops being an alignment estimate and becomes
    a frame-counted fact: the hook clip contains the complete utterance by
    construction, and the splice cut (`hook_end_ms` = hook duration + half the
    buffer) lands in silence we manufactured. No pause markup is injected —
    the buffer IS the hook beat.

    Returns the `render_narration` shape plus the splice fields:
        ``hook_words`` / ``rest_words`` — per-clip grafted timings (rest
        offset by hook + buffer) so captions can be chunked per clip and no
        chunk ever spans the seam;
        ``hook_end_ms`` / ``hook_tail_hold_ms`` — ground-truth splice values
        (the tail hold spans the buffer's second half, all silence);
        ``boundary`` — always ``"measured"``.

    Returns None when the two-clip path can't run — hook missing / not a
    prefix of the normalized script, synth failure, unknown MP3 format — and
    logs the reason LOUDLY. Callers must fall back to `render_narration`;
    every fallback is an incident signal, not a tolerated path.
    """
    spoken_script = text_normalize.normalize_for_tts(script)
    parts = split_hook_prefix(spoken_script, hook)
    if parts is None:
        print(
            "[narration hook_first] FALLBACK reason=hook-not-prefix "
            f"hook={hook!r:.80} script_head={spoken_script[:80]!r}"
        )
        return None
    hook_spoken, rest_spoken = parts
    print(
        f"[narration hook_first] planned hook_chars={len(hook_spoken)} "
        f"rest_chars={len(rest_spoken)} provider={override_provider or 'global'}"
    )

    # The per-clip files are synth staging only; the concatenated file is the
    # narration artifact everything downstream (upload, Remotion) reads. They
    # are removed on every exit — a fallback must not leave strays for the
    # legacy render (which writes `dest_audio` itself) to sit next to.
    hook_path = dest_audio.with_name(f"{dest_audio.stem}-hook{dest_audio.suffix}")
    rest_path = dest_audio.with_name(f"{dest_audio.stem}-rest{dest_audio.suffix}")
    try:
        try:
            hook_res = voice.synthesize(
                hook_spoken, hook_path,
                override_provider=override_provider,
                override_voice_id=override_voice_id,
                speaking_rate=speaking_rate,
                style_prompt=style_prompt,
            )
            rest_res = voice.synthesize(
                rest_spoken, rest_path,
                override_provider=override_provider,
                override_voice_id=override_voice_id,
                speaking_rate=speaking_rate,
                style_prompt=style_prompt,
            )
        except Exception as e:
            print(f"[narration hook_first] FALLBACK reason=synth-error error={e}")
            return None

        try:
            hook_bytes = voice.strip_mp3_container_tags(hook_path.read_bytes())
            rest_bytes = voice.strip_mp3_container_tags(rest_path.read_bytes())
        except OSError as e:
            print(f"[narration hook_first] FALLBACK reason=clip-unreadable error={e}")
            return None
        silence = mp3_silence.silence_mp3_for(voice.mp3_stream_params(hook_bytes))
        if silence is None:
            print(
                "[narration hook_first] FALLBACK reason=no-silence-fixture "
                f"params={voice.mp3_stream_params(hook_bytes)} — regenerate "
                "pipeline/mp3_silence.py for this provider format"
            )
            return None
        try:
            combined = voice.concat_mp3_streams([hook_bytes, silence, rest_bytes])
        except ValueError as e:
            print(f"[narration hook_first] FALLBACK reason=format-mismatch error={e}")
            return None
    finally:
        hook_path.unlink(missing_ok=True)
        rest_path.unlink(missing_ok=True)
    dest_audio.parent.mkdir(parents=True, exist_ok=True)
    dest_audio.write_bytes(combined)

    hook_ms = voice.mp3_duration_ms(hook_bytes)
    silence_ms = voice.mp3_duration_ms(silence)
    rest_ms = voice.mp3_duration_ms(rest_bytes)
    offset_sec = (hook_ms + silence_ms) / 1000.0
    hook_words = captions.align_script_to_words(
        hook_spoken, hook_res.get("words", []), hook_res.get("provider", ""),
    )
    rest_words = [
        {"word": w["word"], "start": w["start"] + offset_sec, "end": w["end"] + offset_sec}
        for w in captions.align_script_to_words(
            rest_spoken, rest_res.get("words", []), rest_res.get("provider", ""),
        )
    ]
    # Cut in the buffer's first half; hold the audio through its second half.
    # Both sides of the cut are constructed silence, so every downstream
    # imprecision (frame math vs decoded timeline, AAC re-encode, video frame
    # snapping) lands in silence instead of speech.
    hook_end_ms = hook_ms + silence_ms // 2
    hook_tail_hold_ms = silence_ms - silence_ms // 2
    print(
        f"[narration hook_first] measured hook_ms={hook_ms} silence_ms={silence_ms} "
        f"rest_ms={rest_ms} total_ms={hook_ms + silence_ms + rest_ms} "
        f"hook_end_ms={hook_end_ms} tail_hold_ms={hook_tail_hold_ms} boundary=measured"
    )
    return {
        "audio": str(dest_audio),
        "words": hook_words + rest_words,
        "provider": hook_res.get("provider"),
        "spoken_script": spoken_script,
        "hook_words": hook_words,
        "rest_words": rest_words,
        "hook_end_ms": hook_end_ms,
        "hook_tail_hold_ms": hook_tail_hold_ms,
        "boundary": "measured",
    }


def split_hook_prefix(spoken_script: str, hook: str | None) -> tuple[str, str] | None:
    """Split a normalized script into (hook_spoken, rest_spoken).

    The hook is beat 1, so it is the script's prefix; both sides are normalized
    the same way and matched case-insensitively. Returns None when the hook is
    missing/blank, is not a prefix (an admin-edited script, say), or IS the
    whole script (nothing left to splice against) — callers treat None as
    "single-clip path". Pure.
    """
    spoken = spoken_script.strip()
    hook_spoken = text_normalize.normalize_for_tts(hook or "").strip()
    if not hook_spoken or not spoken.lower().startswith(hook_spoken.lower()):
        return None
    rest = spoken[len(hook_spoken):].lstrip()
    if not rest:
        return None
    return spoken[:len(hook_spoken)], rest


def _inject_hook_pause(spoken_script: str, hook: str, tag: str) -> str:
    """Return `spoken_script` with `tag` placed after the cold-open hook.

    Legacy single-clip path only (the two-clip path above inserts a real
    silence buffer instead of a markup beat). The hook is beat 1, so it is the
    script's prefix; we normalize it the same way and match it
    case-insensitively (the strict variant of this match is
    `split_hook_prefix`). When the prefix does not line up (an admin-edited
    script, say) we fall back to the first sentence break, and when neither is
    found we return the text unchanged — a missing beat never blocks a render.
    Assumes a bracket-free script (brand safety bans `[...]` in the VO), so the
    only markup the engine sees is our tag.
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
