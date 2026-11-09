# Hook splice: measured boundary via two-clip synthesis

Date: 2026-07-02
Status: approved (manager directive: permanent fix, big changes allowed)
Branch: fix/hook-splice-measured-boundary

## Problem

The hook-first splice reorders a short to [body_hook][intro][body_rest][outro] by
cutting the rendered body at `hook_end_ms`. That boundary is an ESTIMATE: hook
tokens matched against STT word timings, padded 80ms, snapped to a caption edge.
When the TTS runs the hook straight into the next sentence (zero gap), any
estimated cut either clips the hook or bleeds the next line.

Reproduced on story 1mvhekn ("Five dollars. Again today."): the render carried
`hook_end_ms=2000`, `hook_tail_hold_ms=0`, and the caption row shows "Again
today." ending at exactly 2000ms with "Two weeks earlier." starting at 2000ms.
The real spoken "today" extends past 2000ms, so the splice cut it to "tod...".
Three prior band-aids (HOOK_END_PAD_MS=80, per-video tail-hold cap 300ms,
MIN_HOOK_AUDIO_TAIL_HOLD_SEC=150ms) all failed for the same reason: they are
better estimators, and estimation is the disease.

A second latent bug: Lane B (editor voice re-render) replaces the audio but
keeps the baseline's `hook_end_ms`, so every Lane B render cuts new audio at an
old boundary.

## Invariant

The boundary must be CREATED at synthesis time, not detected afterward.

## Chosen approach: two-clip synthesis + measured boundary + silence buffer

1. Synthesize the hook as its own TTS call and the rest of the script as a
   second call (same provider/voice/style prompt; no pause markup needed).
2. Concatenate in pure Python (the Vercel drain has no ffmpeg):
   `voice.mp3 = hook_clip + SILENCE + rest_clip`, where SILENCE is ~300ms of
   pre-encoded MP3 silence matching the clip's exact MPEG format (version,
   layer, sample rate, channel mode), committed to the repo as embedded bytes.
   ID3v2/ID3v1 tags and Xing/Info/VBRI header frames are stripped from every
   part so the stream decodes cleanly (verified empirically: naive concat with
   embedded tags produces a decoder error; stripped concat decodes clean).
3. `hook_end_ms = frame-counted duration(hook_clip) + SILENCE/2` and
   `hook_tail_hold_ms = SILENCE/2 (=150ms)`. The cut lands in the middle of
   silence we manufactured. Frame math vs decoded-timeline error (encoder
   delay/padding, ~20-80ms, measured locally at ~40-60ms) overstates the hook
   duration, i.e. errs AFTER the last spoken sample — and the 300ms buffer
   absorbs it plus the splice's AAC (~21ms) and video-frame (~33ms)
   quantization with an order of magnitude of margin.
4. Captions: STT/provider alignment runs per clip; rest-clip word times are
   offset by duration(hook)+SILENCE; caption chunks are built per clip so no
   chunk spans the seam. The scene-edge snap (`_extend_first_scene_over_hook`)
   still shifts doodle frames past the hook but no longer moves the cut point
   (snap=False in measured mode).
5. Lane B re-renders go through the same path and ALWAYS overwrite
   `hook_end_ms`/`hook_tail_hold_ms` from the new audio. The stale-carry
   behavior is deleted. If the (possibly editor-edited) script no longer starts
   with the hook, Lane B falls back to the alignment estimate — still fresher
   than a stale boundary — and logs it.
6. Fallback: if the hook is not a prefix of the normalized script, or the two-
   clip path fails (format mismatch, synth error), the render falls back to
   today's single-clip estimated path and logs `[narration hook_first] FALLBACK
   reason=...` loudly. Fallback is an incident signal, not a tolerated path.

No TypeScript / Cloud Run changes: the existing props contract
(`hook_end_ms`, `hook_tail_hold_ms`) simply starts carrying ground-truth
values, and `hook_tail_hold_ms=150` equals the existing render.ts floor. No new
props keys (route.ts strips only known keys; an unknown key would reach
Remotion as a phantom prop).

## Why this is permanent

- "Where does the hook end" becomes "how long is this file" — a fact measured
  by counting MPEG frames (exact, additive; property-tested), not an inference
  from an alignment model.
- Both sides of the cut are silence BY CONSTRUCTION, so every downstream
  imprecision lands in silence. Clipping becomes unrepresentable, not unlikely.
- The TTS engine gives the standalone hook sentence-final prosody, so the
  cold open also sounds more deliberate than a mid-stream chop.

## Alternatives rejected (LLM Council, 5 advisors + peer review, 2026-07-02)

- Silence-detect on Cloud Run near the estimated boundary: fails exactly in the
  failing case (no pause = no silence); stop-consonant closures create false
  positives inside words.
- Better alignment / midpoint cuts / provider timestamp endpoints: still
  estimates over a continuous waveform; Gemini-TTS (the locked shorts voice)
  has no SSML mark support; even exact synthesizer timepoints cut coarticulated
  run-on speech.
- Decode-to-PCM concat on Cloud Run: the boundary and merged captions are
  needed upstream on Vercel where captions/scene switches are computed; moving
  the join downstream leaves the Vercel side estimating again.
- Separate Remotion compositions per segment (no mid-stream cut at all):
  architecturally cleaner endgame, but a much bigger change to render dispatch;
  scheduled as a possible follow-up, not this fix.
- Council-flagged trap avoided: do NOT build the segment-manifest flywheel
  (per-segment voice params, hook A/B) until the primitive has soaked.

## Files

- NEW `pipeline/mp3_silence.py` — embedded base64 silence blobs per provider
  format + `silence_mp3_for(params)` lookup. Generated by
  `pipeline/scripts/gen_mp3_silence.py` (dev machine, requires ffmpeg).
- `pipeline/voice.py` — MP3 stream helpers next to the existing frame parsers:
  `mp3_stream_params()`, `strip_mp3_container_tags()`, `concat_mp3_streams()`,
  and `mp3_duration_ms(bytes)` (refactor of `audio_duration_ms`).
- `pipeline/narration.py` — `render_hook_first_narration()` (two calls, concat,
  per-clip grafted words, measured boundary) + shared hook-prefix splitter.
- `pipeline/shorts_render.py` — measured path in `build_short_props`; per-clip
  caption chunking; snap=False; loud structured logs; legacy path unchanged.
- `pipeline/shorts_lane_b.py` — recompute boundary on every re-render.
- Tests under `pipeline/tests/`.

## Security

No new inputs, no new attack surface: the same script/hook strings already flow
to the TTS providers; the silence bytes are static repo constants; no secrets
touched; no new network calls beyond a second call to the SAME TTS/STT
endpoints already in use. Format validation rejects malformed/mismatched MP3
streams and falls back closed (legacy path) rather than shipping a broken file.

## Observability

- `[narration hook_first] planned hook_chars=... rest_chars=... provider=...`
- `[narration hook_first] measured hook_ms=... silence_ms=... rest_ms=...
  total_ms=... boundary=measured`
- `[narration hook_first] FALLBACK reason=<hook-not-prefix|format-mismatch|
  no-silence-fixture|synth-error> ...` (the regression tripwire)
- `[short id=... hook_boundary] source=measured|aligned|fallback|empty ...`
  (existing log, gains the `measured` source)
- Lane B: `[short laneB hook] recomputed hook_end_ms=... source=...`
- Cloud Run dispatcher logs (`hook_end_sec`, `tail_hold_sec`) unchanged.

## Settings

No new user-facing settings. The silence buffer (300ms) and boundary placement
are engineering constants intrinsic to splice correctness — a knob would only
let a user reintroduce the bug. Voiceover presets (provider, voice, style
prompt, speaking rate, hook_pause) are untouched; `hook_pause` is simply
ignored on the two-clip path because the splice gap replaces it (it still
applies on the legacy fallback path).

## Cost

Same character totals split across two TTS calls (per-character billing on both
providers), plus: the Gemini style prompt is billed once more per short
(~100-300 chars) and the Google STT alignment runs twice (billed per 15s
increment, so typically one extra increment, well under a cent per render).
Verified as negligible; no new paid service.

## Testing

- `test_voice_mp3.py`: tag/Xing stripping, stream param parsing, format-
  mismatch rejection, exact duration additivity on real committed MP3 fixtures
  (Google-format 24kHz mono MPEG-2 L3 and ElevenLabs-format 44.1kHz MPEG-1),
  silence lookup hit/miss.
- `test_narration_hook_first.py`: prefix split (exact, case, punctuation,
  non-prefix -> None), measured boundary math, rest word offset, per-clip
  grafting, fallback on synth failure / format mismatch (mocked synthesize).
- `test_shorts_render.py` additions: measured path sets props from ground
  truth, snap disabled, caption chunks never span the seam, legacy path
  byte-identical when the hook is missing; regression case shaped like
  1mvhekn (two-sentence hook, zero-gap alignment) asserting the cut sits in
  constructed silence, not at the alignment edge.
- Lane B: re-render recomputes boundary; stale value never survives.
- Full pipeline suite green before done.

## Deploy

Standard flow only: PR from `fix/hook-splice-measured-boundary` into `main`;
merge deploys the Vercel app (drain included). Cloud Run video server needs NO
redeploy (no TS changes) — no two-stage deploy, no ordering constraint.
Rollback = revert the PR; rows rendered meanwhile stay valid because the props
contract is unchanged. No pushes/merges without explicit approval per standing
rules.

## Open questions

- ElevenLabs channel mode (mono vs joint stereo) is read from the real stream
  at runtime; fixtures are committed for both. If a provider ships a new format
  the lookup misses, the render falls back (logged) rather than guessing.
- Follow-up candidate (separate work): render hook/rest as separate segments
  end-to-end and delete the mid-stream cut + estimation machinery entirely.
