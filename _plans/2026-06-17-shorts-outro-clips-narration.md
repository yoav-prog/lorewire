# Shorts: outro clips the narration (body too short)

**Date:** 2026-06-17
**Status:** Fixed + tested

## Symptom

The rendered short ends before the narration finishes — the spliced outro starts
while the last words are still being spoken. The 1.5s post-roll hold did not help
because the gap was larger than 1.5s.

## Root cause

The short is rendered as `body` then `intro + body + outro` are concatenated
(`video/server/ffmpeg.ts` — a plain `concat`, no overlap). So the outro starts
exactly at the end of the body MP4. The body length is
`durationInFrames = ceil((duration_ms + end_hold_ms)/1000 * 30)` and Remotion
drops any narration audio past `durationInFrames`.

`duration_ms` was set to `captions[-1].end_ms` — the end of the last ALIGNED
WORD. On providers whose word timings undershoot the real file (ElevenLabs char
timings aren't calibrated to the audio; Google's are), the actual MP3 runs longer
than the last word's end by more than the 1.5s hold, so the body ends mid-word
and the outro clips it.

## Fix

Floor the body length at the REAL audio duration in both render paths:

    duration_ms = max(captions[-1].end_ms, voice.audio_duration_ms(audio_path), 1)

- `pipeline/voice.py` — new `audio_duration_ms(path)`: a general, pure-stdlib MP3
  duration probe (no ffprobe, so it runs in the Vercel drain). Reads version +
  sample rate + bitrate off every MPEG frame header, so it is exact for any TTS
  provider (the existing `_probe_mp3_duration` was hard-wired to Google's 24 kHz
  mono MPEG-2). Returns 0 on failure → callers fall back to the caption end.
- `pipeline/shorts_render.py:build_short_props` (full / Lane A) and
  `pipeline/shorts_lane_b.py:build_short_props_lane_b` (voice re-render) both
  floor `duration_ms` at the probe value. `end_hold_ms` (1.5s) then adds the
  post-roll on top, so the held last frame plays for 1.5s AFTER the narration
  ends, before the outro.

The probe can only ever EXTEND the body to cover more audio, never shorten it —
so this can't regress a correctly-sized short and fails safe (probe=0 → old
behavior).

## Guarantee (what the tests prove)

1. `audio_duration_ms` is exact: tested against hand-built MPEG-1 (44.1 kHz) and
   MPEG-2 (24 kHz) frame streams of known count → known duration.
2. Both render paths set `duration_ms = max(caption_end, audio_ms)`: tested with
   the probe stubbed above the caption end; the body adopts the audio length.
3. `deriveCompositionMetadata` grows `durationInFrames` by `end_hold_ms`
   (video/src/composition-metadata.test.mjs).

(1) + (2) + (3) ⟹ body length = `duration_ms + 1.5s ≥ audio + 1.5s`, and the
concat outro starts at body end, so the narration always finishes 1.5s before
the outro.

## Not verified here

The actual Cloud Run Remotion render isn't run in this environment (needs the
render service + live asset URLs). The invariant above is proven by unit tests on
the real code; the final visual confirmation is the next full re-render.
