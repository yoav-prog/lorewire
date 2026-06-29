# Shorts: outro clipping, caption tail, and editor cache fixes

**Date:** 2026-06-18
**Status:** Planned, executing
**Branch:** `feat/multi-platform-shorts-publisher`

## Goal

Permanently fix three issues the user surfaced on THE STEAK STANDOFF
prod render:

1. **Outro music cuts the closing narration mid-word.** Confirmed via
   audio analysis of the rendered MP4: voice extends to video time
   37.20s, outro music begins at 37.31s — effective gap of 0.11s. The
   1500ms tail-pad we cherry-picked (`6775c13` / main's `b6c0b59`) is
   not enough because the body's duration was computed from the last
   caption's `end_ms`, not from the actual audio length, and the
   audio runs ~2s past the last caption on this provider.

2. **Captions stop before the audio does.** The audio has ~2.4
   seconds of trailing speech that no caption describes. The user
   reads "serving her?" then hears another full sentence — feels like
   "captions completely unrelated to narration." Same root cause as
   #1: caption alignment ends early relative to the actual audio.

3. **Editor still shows the previous render's scenes after a
   regenerate.** `short_config.doodle_frames[].url` matches the
   latest render exactly (verified via direct DB queries), so the
   data IS correct — but URLs are reused per slot (`frame-00.png`,
   `frame-01.png`, ...) on every render, and browsers cache by URL.
   So the user sees the previous render's cached image even though
   GCS now serves the new one.

## Root cause analysis (verified, not guesses)

| Bug | What I verified | Why it breaks |
|---|---|---|
| Outro cuts speech | `voice.mp3` standalone = 31.25s; rendered MP4 audio has speech to body 33.19s. Body length 33.3s = `captions[-1].end_ms` (30.8s) + ~2.5s of slack. | `duration_ms = max(captions[-1].end_ms, 1)` undershoots the real MP3 when TTS provider word timings undershoot the audio file. |
| Captions trail off | DB captions span 0→30.8s; rendered MP4 has speech to 33.19s. | Same root cause — caption alignment ends at last word's timestamp, which doesn't cover the audio file's full duration. |
| Editor shows stale scenes | `short_config.doodle_frames[0].url == latest_render.props.doodle_frames[0].url` (identical URLs). | Same URL across renders → browser image cache returns the previous render's bytes even after the new render overwrites the GCS object. |

## Approach

### Fix A — body length = max(captions_end, real_audio_ms) + end_hold

Port two existing-but-not-yet-merged commits from `feat/reels-feed`:

- **`5c9e7cb` — body length to real audio.** Adds
  `voice.audio_duration_ms(path)` (pure stdlib MP3 frame-header
  probe, runs in the Vercel Python drain — no ffprobe dep). Floors
  `duration_ms` at the actual audio length in both `shorts_render`
  (full) and `shorts_lane_b` (voice re-render). Falls back to old
  behavior on probe failure.

- **`61a4ba0` — 1.5s end-hold post-roll.** Adds `end_hold_ms = 1500`
  to short props. Composition grows `durationInFrames` by `end_hold`
  after the trim so the last frame lingers 1.5s past the narration
  before the outro splice. Threaded through `render_short` route +
  TS config mirrors.

Together: body covers all spoken audio, last frame held 1.5s after
audio ends, outro splices in after the hold. Outro CANNOT cut speech.

### Fix B — extend the last caption to cover the audio tail

When the audio duration probe shows the audio runs past
`captions[-1].end_ms`, extend the last caption's `end_ms` to match
the probed audio duration. The text doesn't change — the trailing
uncaptioned speech is the TTS provider's tail anyway (artifacts,
trailing breath, late phoneme); presenting the last caption text for
that extra second is honest to the spoken content. Done in both
`shorts_render` and `shorts_lane_b` right after audio probe, before
`duration_ms` is stamped on props.

### Fix C — cache-bust per-render frame URLs

Frame URLs are stored on `short_config.doodle_frames[].url` and on
`short_renders.props.doodle_frames[].url`. Append a render-id query
string suffix when staging, so the URL changes on every render even
though the underlying GCS object path stays stable (Cloud Run's
fetch still hits the same `frame-NN.png`). Browsers see a different
URL and bypass the image cache.

Concretely: after `gcs.publish(...)` returns the URL, append
`?v={render_id_short8}` before storing into `staged[]`. The render
cron and editor both see the cache-busted URL. The GCS object
remains addressable at its stable path for re-fetches and audits.

## Files I expect to touch

| File | Why |
|---|---|
| `pipeline/voice.py` | New `audio_duration_ms(path)`. From `5c9e7cb`. |
| `pipeline/shorts_render.py` | Floor `duration_ms` at audio probe, extend last caption to audio length, cache-bust frame URLs with render_id. |
| `pipeline/shorts_lane_b.py` | Floor `duration_ms` at audio probe, extend last caption. From `5c9e7cb`. |
| `lorewire-app/src/app/api/render_short/route.ts` | Inject `end_hold_ms` on dispatch (from `61a4ba0`). |
| `video/src/short-types.ts` (or similar) | Type mirror for `end_hold_ms` (from `61a4ba0`). |
| `video/src/composition-metadata.ts` | Grow `durationInFrames` by `end_hold` (from `61a4ba0`). |
| `video/src/DoodleShort.tsx` | Stretch last frame's window to fill the hold (from `61a4ba0`). |

## Tests (rule 18 — non-negotiable)

- `pipeline/tests/test_audio_duration.py` — exact probe on crafted
  MPEG-1 + MPEG-2 frames, malformed input returns 0 (cherry-pick).
- `pipeline/tests/test_shorts_render.py` — assert
  `duration_ms == max(captions_end, probe_ms)` (cherry-pick).
- `pipeline/tests/test_shorts_lane_b.py` — same assertion for Lane B
  (cherry-pick).
- **New** `pipeline/tests/test_shorts_render.py::test_last_caption_extends_to_audio_tail`
  — when audio is longer than the last caption's end_ms, the last
  caption's end_ms is bumped up to audio_ms.
- **New** `pipeline/tests/test_shorts_render.py::test_frame_urls_carry_render_id_query`
  — staged frame URLs end in `?v=` + the 8-char render id prefix.
- `video/src/composition-metadata.test.mjs` — body grows by end_hold
  past the trim (cherry-pick).

## Observability (rule 14)

- `pipeline/shorts_render.py` — log
  `[shorts duration] story=X probe_ms=N captions_end_ms=M chosen=K end_hold_ms=H`
  so a "did the audio-floor fire" debug session can see exactly which
  number won.
- Same log in `pipeline/shorts_lane_b.py`.

## Settings audit (rule 15)

- `video.outro_lead_in_ms` (existing) — current default 1500ms
  matches `end_hold_ms` default 1500ms. Keep both at 1500 by default.
  After this fix, the user can lower or raise either independently
  if needed.
- No new user-facing knobs. The audio-duration floor is automatic
  (no story is hurt by a slightly longer body — it just keeps the
  audio finishing cleanly).

## Cost (rule 8)

$0 marginal per video. No new image / voice / LLM calls. The audio
probe is local file analysis. The end_hold + cache-bust are pure
metadata.

## Security (rule 13)

No new attack surface. The audio probe reads MP3 frame headers from
a path we wrote ourselves. The cache-bust query string is server-
generated from the render id (UUID) — not user input.

## Rollout

1. Cherry-pick `5c9e7cb` + `61a4ba0`. Resolve any conflicts.
2. Add Fix B (last-caption extension) on top.
3. Add Fix C (cache-bust query).
4. Run full pipeline + UI test suite.
5. Push to branch.
6. User promotes to production.
7. Re-render THE STEAK STANDOFF. Verify outro no longer cuts, last
   caption extends to audio tail, editor shows new scenes after
   refresh.

## Not in scope (will be tracked separately if surfaced)

- "Wife changes between renders" — the world bible should be reused
  across renders for stable characters, but this is a separate
  pipeline architectural fix (the bible is currently rebuilt on every
  force-regenerate).
- Long-form `video_config` getting overwritten by short data or vice
  versa — confirmed both columns exist with correct data right now;
  no fix needed for this specific render.
