# Hook before the brand intro — every short opens on the climax, not on "LORE WIRE"

Date: 2026-06-28
Owner: Yoav
Status: Draft, awaiting approval (architectural direction already approved by manager + Yoav 2026-06-28)

## Why this exists

Manager flagged on 2026-06-28 (Hebrew, paraphrased): every Lorewire
Instagram Reel thumbnail is the same image, and the first 2-3 seconds
of every short are a brand introduction instead of the story. His
prescription was literal: *"the HOOK / 2-3 first seconds should come
BEFORE the introduction."*

## Investigation trail (kept so future-me knows what's real and what was wrong)

**First hypothesis (wrong):** I assumed there was no intro because
[video/src/DoodleShort.tsx](../video/src/DoodleShort.tsx) has no
intro card / brand stinger / logo bumper inside the composition, and
the script in
[pipeline/shorts_narration.py](../pipeline/shorts_narration.py)
already structures itself hook-first at beat 1. I theorized the
identical thumbnails came from a silent character-base fallback in
[pipeline/shorts_render.py:341-364](../pipeline/shorts_render.py#L341-L364).
A full LLM-council pass pressure-tested that plan.

**Verification (2026-06-28):** Yoav asked me to actually pull the 6
IG-posted Reels' MP4s and diff their frame-0 PNGs (md5).

- All 6 frame-0 PNGs are byte-identical
  (`fb27f640608135bc4e5e8d3403596174`).
- Each story's scene-1 image on GCS is unique (6 different md5s, 6
  different file sizes — verified via direct fetch of
  `frame-00.png` per story).
- Walking frame-by-frame across two stories shows frames are
  **identical from t=0 through t=3.0s** and start to **diverge at
  t=3.5s**. Every short carries a ~3-second pre-roll that the
  composition is unaware of.
- The pre-roll's audio is non-silent (mean -17 dB, max -3.6 dB) — a
  brand stinger plays underneath.
- Frame at t=2.5s shows the "LORE WIRE" wordmark with red animated
  lighting. Confirmed: this is a branded title card concatenated to
  the front of every short.

**Real root cause:** [pipeline/segments.py](../pipeline/segments.py)
is a working-as-designed intro/outro splicer. Its `splice()` runs a
single FFmpeg `concat` pass on `[intro][body][outro]` after Remotion
renders the body. The intro segment is a pre-recorded 1080x1920 MP4
of the LORE WIRE brand title card, normalized and stored in the
`video_segments` table. Per-story override exists in the schema
(per-story pin > global active > none) but in practice every short
gets the global default. The manager's diagnosis was correct, his
prescription was correct, and my "there is no intro" claim was wrong
because I only looked inside Remotion and missed the post-render
concat layer.

## Goals

1. Every short's first 2-3 seconds is the spoken cold-open hook of
   that story (the existing beat-1 line) over the story's own
   cold-open scene image. The brand stinger plays AFTER the hook
   lands, not before.
2. Instagram's auto-thumbnail (frame 0 of the video) becomes the
   unique cold-open scene image per story — no more identical
   red-beam thumbnails.
3. Brand presence is preserved: the LORE WIRE stinger still runs as
   a mid-roll between the hook and the rewind, plus the channel
   pill stays on the body, plus the outro stays at the end.
4. Existing intros for non-shorts video flows (if any) are not
   silently changed.
5. No new production takedown. Deploy respects the inverted Vercel
   state per [lorewire-app/AGENTS.md](../lorewire-app/AGENTS.md).

## Constraints

- The change spans **two splice implementations** because production
  shorts render through Cloud Run (TypeScript) while local + long-
  form render through the Python pipeline. Both code paths get
  symmetric hook-first support so a Cloud Run render and a local
  render produce byte-equivalent output (modulo encode
  non-determinism). The Python side was originally said to be the
  only path; that was wrong — the plan author missed the Cloud Run
  TS path during the diagnosis phase. Files actually touched:
  - **Python (long-form + local shorts):**
    - [pipeline/shorts_render.py](../pipeline/shorts_render.py) —
      compute `hook_end_ms` from alignment + hook field, write to
      `props["hook_end_ms"]`.
    - [pipeline/segments.py](../pipeline/segments.py) — `splice()` +
      `_ffmpeg_splice_cmd()` accept `hook_end_sec`; new private
      `_ffmpeg_splice_cmd_hook_first()` for the reordered argv.
  - **TypeScript (production shorts via Cloud Run):**
    - [video/server/ffmpeg.ts](../video/server/ffmpeg.ts) —
      `buildConcatArgv()` accepts `hookEndSec`; new private
      `buildHookFirstArgv()`.
    - [video/server/render.ts](../video/server/render.ts) —
      `SpliceSegments` gains `hookEndSec?: number`;
      `spliceWithSegments` threads it through to the argv builder.
    - [video/server/index.ts](../video/server/index.ts) —
      `parseSegments()` reads `hookEndSec` (and the previously-
      dropped `outroLeadInSec`) off the POST body.
    - [lorewire-app/src/app/api/render_short/route.ts](../lorewire-app/src/app/api/render_short/route.ts) —
      `extractHookEndSecFromProps()` pulls `hook_end_ms` off
      `inputProps`, strips the key (so Remotion never sees it), and
      forwards the seconds-form on `segments.hookEndSec`.
- No new external dependencies, no new image generation, no new
  audio rendering.
- The Remotion composition is unchanged. The body MP4 it produces
  already has the hook at t=0 — we are just changing what gets
  concatenated where.
- The intro / outro `video_segments` rows are unchanged. The
  brand stinger MP4 doesn't get re-cut; only its placement in the
  concat changes.
- The hook timestamp is read from the alignment data (`vres["words"]`
  in shorts_render.py) — the same word-level timestamps that drive
  the caption chunks. No new LLM call, no new model.
- Audio continuity: when the body splits at the hook boundary and
  the brand stinger plays mid-roll, the narration audio cleanly
  ends on the hook's last word and resumes on the rewind cue ("This
  started six days earlier."). The brand stinger fills the gap. No
  cross-fade work needed in v1.

### Side fix: `outroLeadInSec` was a latent bug

While threading `hookEndSec` through `parseSegments` in
[video/server/index.ts](../video/server/index.ts), I found that
`outroLeadInSec` was declared on the `SpliceSegments` interface,
used by the renderer, and posted by the long-form video dispatcher —
but `parseSegments` was silently dropping it before forwarding to
the renderer. So the silence-before-outro pad never actually applied
on production. The hook-first parser fix added `outroLeadInSec`
extraction in the same character-class change. New regression test
locks the fix in. Out of scope of the original plan but trivial to
ship alongside; documented for posterity.

## Chosen approach

### Part 1 — Compute the hook boundary timestamp (Python)

File: [pipeline/shorts_render.py](../pipeline/shorts_render.py).

New pure helper `compute_hook_end_ms(hook, words)` returns
`(hook_end_ms, source)` where `source ∈ {"aligned", "fallback",
"empty"}`:

1. Tokenize `script["hook"]` into words — lowercase + strip
   apostrophes (so "don't" matches alignment "dont") + split on
   non-alphanumerics.
2. Walk `vres["words"]` in order, matching tokens. Only count a
   match when the alignment entry carries a valid `end` timestamp —
   without it we can't compute a real boundary and would otherwise
   silently fall through to a stale value from the previous word.
3. **aligned**: every hook token matched in order → last matched
   word's end + `HOOK_END_PAD_MS = 80ms`.
4. **fallback**: hook had tokens but the alignment couldn't be
   matched (drift, homophone, empty alignment) → `HOOK_FALLBACK_MS
   = 2500` (midpoint of the script's 1.5–3s beat-1 budget).
5. **empty**: no hook tokens → `0` so the splice falls through to
   legacy ordering (no reorder for shorts with no hook).

`build_short_props` calls the helper after the alignment is in
scope, logs `[short id=... hook_boundary] computed hook_end_ms=…
source=…` per global rule 14, and writes the value onto
`props["hook_end_ms"]`.

### Part 2 — Split the body at the hook boundary and reorder the splice (both Python AND TypeScript)

Files:
- [pipeline/segments.py](../pipeline/segments.py)
  (`_ffmpeg_splice_cmd` + new `_ffmpeg_splice_cmd_hook_first`)
- [video/server/ffmpeg.ts](../video/server/ffmpeg.ts)
  (`buildConcatArgv` + new `buildHookFirstArgv`)

Today's flow:

```
inputs = [intro, body, outro]
ffmpeg concat → [intro][body][outro]
```

New flow when `hook_end_sec > 0` AND an intro is in the chain:

```
physical argv: -ss 0 -t T -i body  -i intro  -ss T -i body  -i outro
ffmpeg concat → [body_hook][intro][body_rest][outro]
```

`body` is listed twice in the physical argv (same file, different
`-ss`/`-t`) so one re-encode pass produces the rearranged stream.
The existing `body_tail_pad_sec` (silence pad before the outro
audio) attaches to `body_rest` instead of the original body so the
outro still gets its lead-in pad.

The reorder is gated behind two checks: `hook_end_sec > 0` AND the
body is not already the first input. If either fails, splice falls
through to the legacy `[intro][body][outro]` ordering byte-for-byte.

### Part 3 — Wire the hook timestamp through to the splice (both paths)

For the Python long-form path: `pipeline/video.py::generate_video`
already calls `segments.splice(...)`; the function accepts the new
`hook_end_sec` kwarg (default 0.0) so a caller can opt in. Long-
form video doesn't have a hook so it stays at default — no behavior
change for that path.

For the production short path (Cloud Run): the dispatcher
[lorewire-app/src/app/api/render_short/route.ts](../lorewire-app/src/app/api/render_short/route.ts)
reads `inputProps.hook_end_ms` (set by Python `build_short_props`),
strips the key so Remotion never sees a phantom prop, converts to
seconds, and forwards on `segments.hookEndSec` in the POST to Cloud
Run. The Cloud Run service ([video/server/index.ts](../video/server/index.ts)
+ [video/server/render.ts](../video/server/render.ts)) parses the
field and threads it into `buildConcatArgv`.

## Alternatives rejected

1. **Remove the brand intro entirely.** Cleanest engineering but
   the manager wants the brand preserved. Stays on the table if the
   hook-then-intro mid-roll feels weird in production; revisit after
   2 weeks of new shorts under the new arrangement.

2. **Shorten the intro to <1s.** Cheapest fix but doesn't solve the
   thumbnail problem (frame 0 is still the brand, just for less
   time). Rejected per manager.

3. **Re-cut the brand intro to lead with the climax image of the
   story.** Would require generating a per-story intro variant — a
   render per short, not a static asset. Heavy lift, conflates the
   brand asset with the story asset. Out of scope.

4. **Burn the hook line as text overlay on top of the intro frames
   instead of moving the intro.** Manager's prescription is about
   the ORDER, not about decorating the intro. Decorating it would
   still leave frame 0 as the brand image, so the thumbnail problem
   stays.

5. **Skip Part 1 (don't compute hook_end_ms from alignment) and
   hardcode a 2.5s split.** Almost works (the hook budget is 1.5-3s)
   but a tail-loose hook (slow narrator, longer alignment) gets cut
   mid-syllable. Reading the boundary from alignment costs a single
   list walk and avoids the edge case. Cheap insurance.

## Open questions

1. **Does the mid-roll brand stinger feel like a "scene break"
   between hook and rewind, or like an interruption?** This is a
   judgment call once the first re-rendered short exists. Watch the
   first 3 shorts after the change and decide whether the intro
   length needs trimming.

2. **Per-story override of the intro on/off in the existing
   per-story pin schema** — should we expose a "no intro on this
   short" toggle in admin so a particular story can opt out, or
   keep it as a global brand contract? Defer: not asked, no clear
   case yet, ship the global change first.

3. **Should the IG publisher also set an explicit `cover_url` as a
   defense-in-depth layer?** Now that frame 0 is the story's unique
   cold-open scene, IG's auto-thumbnail is correct without
   intervention. The `cover_url` work is a follow-up plan in case
   IG ever picks a different frame (smart cover) or we want to
   override with the hero. Park as a separate plan, not blocking.

4. **The silent character-base fallback at
   [pipeline/shorts_render.py:341-364](../pipeline/shorts_render.py#L341-L364)
   is a latent bug** — when scene staging fails, every short would
   silently fall back to the same character base image, which
   matches today's symptom by accident. Park as a separate plan
   (write a hard-failure or generated-placeholder fix). It is not
   the cause of the current symptom and not blocking this work.

## Security

- No new auth surface, no new env vars, no new external dependencies.
- The new ffmpeg invocation operates on already-trusted, already-
  normalized inputs (body MP4 the Remotion renderer produced; intro
  MP4 from the `video_segments` admin upload, already normalized by
  the same module).
- No PII in the new log line (story id + integer ms + bool flag).

## Observability

Per global rule 14:

- `[short id=... hook_boundary] computed` — story_id, hook_end_ms,
  matched_words, fallback (bool). Fires once per render.
- `[segments splice] reorder=hook_first` — splice mode, body_hook_ms,
  body_rest_ms, intro_present (bool), outro_present (bool). One log
  per splice. The existing `[segments splice]` line gains the
  `mode` field so the operator can see whether each render took the
  new ordering or the legacy path.
- No new dashboards needed; the existing render-pipeline log surface
  in `/admin/(panel)/settings/socials` and the `[short queue ...]`
  worker logs already follow renders end-to-end.

## Settings

Per global rule 15:

- **No new settings.** The hook-then-intro ordering is a brand
  invariant per the manager. Exposing it as a per-short toggle would
  let it drift, which defeats the manager's directive.
- Existing `video.outro_lead_in_ms` setting still applies (the pad
  before the outro audio cuts in). Behavior unchanged.
- Existing per-story intro/outro pin in the `stories` table still
  honored (admin can override the global intro for a specific
  story).

## Testing

Per global rule 18:

Tests shipped with this plan, grouped by surface:

### Python — `pipeline/tests/test_segments.py::FfmpegCmdShapeTests`

Six new tests covering the hook-first argv shape:
- Reorder to `[body_hook][intro][body_rest][outro]` with the right
  `-ss`/`-t` pattern and concat filter for the canonical
  `inputs=[intro, body, outro]`.
- Tail-pad lands on `body_rest` (not `body_hook`) so the outro still
  gets its silence-before-outro contract.
- Without an outro the pad drops (body_rest is now last in the chain).
- `hook_end_sec=0` produces byte-identical argv to the unchanged
  path — opt-in semantics.
- No-intro inputs ignore `hook_end_sec` and stay legacy.
- `has_audio=false` drops apad and audio map cleanly.

### Python — `pipeline/tests/test_shorts_render.py::ComputeHookEndMsTests`

Eight new tests covering the boundary computation:
- aligned (every hook token matched in order)
- aligned with case + punctuation + apostrophe normalization
  ("DON'T LOOK NOW." vs "dont look now")
- aligned stops at hook boundary, ignores alignment past the hook
- fallback when alignment doesn't contain hook tokens
- fallback when alignment is empty
- empty source when hook is missing / blank / punctuation-only
- aligned tolerates trailing-punctuation in alignment words
  ("hook." matches "hook")
- fallback when alignment entry on the last hook word has no `end`
  timestamp (refuses to emit a stale value from the previous word)

### TypeScript — `video/server/ffmpeg.test.mjs`

Six new tests mirroring the Python argv tests so the Cloud Run path
and the local Python path produce equivalent output.

### TypeScript — `video/server/index.test.mjs`

Three new tests for the `parseSegments` POST-body parser:
- forwards `hookEndSec` when it's a positive number
- drops `hookEndSec` for `<= 0`, non-finite, or wrong types
- locks the latent `outroLeadInSec` fix (side fix above)

### TypeScript — `lorewire-app/src/app/api/render_short/route.test.ts`

Five new vitest tests for `extractHookEndSecFromProps`:
- positive `hook_end_ms` → seconds + key stripped from props
- absent `hook_end_ms` → null, props untouched
- malformed `hook_end_ms` → null, but key still stripped (so it
  never leaks into Remotion props)
- non-object inputProps → null, no mutation
- absent key → no mutation

### Run

```
# Python pipeline tests
python -m pytest pipeline/tests/test_segments.py::FfmpegCmdShapeTests \
  pipeline/tests/test_shorts_render.py::ComputeHookEndMsTests -v

# TypeScript server tests
cd video && npm run test:server

# Vitest helper
cd lorewire-app && pnpm vitest run src/app/api/render_short/route.test.ts
```

### Manual smoke (post-deploy)

Render one short end-to-end on production after the merge. Pull the
resulting MP4 and `ffprobe -ss 0 -t 1 -frames:v 1`. The first frame
should show the story's cold-open scene, NOT the LORE WIRE title
card. Confirm by comparing to the pre-fix bug evidence: the 6 IG
Reels' frame-0 PNGs all hashed to `fb27f640608135bc4e5e8d3403596174`.

### Pre-existing test failures (not caused by this PR)

The full pipeline test suite has 6 pre-existing failures on the
`feat/multi-platform-shorts-publisher` baseline (5 in PickSegment
aspect-resolution drift, 1 in BuildShortPropsBaseFrameTests URL-shape
regression). Verified by checking out the unchanged file from
`origin/feat/multi-platform-shorts-publisher` and re-running — the
same tests fail. Not in scope for this PR; flagged so the diff
review doesn't blame them on this change.

## Deploy

Per global rule 19 and [lorewire-app/AGENTS.md](../lorewire-app/AGENTS.md):

**Current Vercel state (must verify at deploy time):**
production-source branch is `feat/multi-platform-shorts-publisher`
(the inverted state after the 2026-06-22 / 2026-06-23 takedowns).
`main` is behind production.

**Branch:**

- Off `feat/multi-platform-shorts-publisher`. Suggested name
  `fix/hook-before-brand-intro`.
- One small PR. Two files in pipeline/, two test files in
  pipeline/tests/. No frontend or migration.

**Promotion path:**

- PR targets `feat/multi-platform-shorts-publisher`.
- CI runs the two new test files plus the existing pipeline suite.
- Merge auto-deploys to production via Vercel's Production Branch
  tracking.
- Do NOT click "Promote to Production" / "Redeploy" / "Rebuild" on
  any non-production-source preview in the Vercel UI per AGENTS.md.
- Do NOT merge to `main` as part of this work. `main` is still
  behind production; merging anything there triggers a deploy of
  stale main per AGENTS.md.

**Post-merge — manual operator action:**

1. Wait for production to deploy (Vercel build watch).
2. Use the bulk-regen UI from
   [_plans/2026-06-28-bulk-regen-shorts.md](2026-06-28-bulk-regen-shorts.md)
   to regenerate the ~6 IG-posted stories' shorts. The new MP4s
   open on the unique cold-open scene per story.
3. Re-publish each IG Reel via the existing manual flow
   (`PublishToInstagramButton` already has delete-previous +
   post-new). Six manual republishes, ~1 minute total.
4. Confirm in the IG app that the 6 thumbnails are now distinct
   per story (the unique doodle scene-1 illustrations).

**Rollback:**

- `git revert` the merge commit on the production-source branch.
  Production auto-redeploys to the pre-change state.
- Future renders revert to the legacy `[intro][body][outro]`
  ordering. Already-republished IG Reels stay republished
  (manual operator action is not reverted by the code rollback —
  acceptable cost; the new thumbnails are an improvement either way).

**Confirm with Yoav before pushing:**

1. The branch the PR targets
   (`feat/multi-platform-shorts-publisher`).
2. That bulk-regen plan is ready to use (or willing to use the
   existing single-story regen if bulk-regen hasn't shipped yet).
3. That republishing IG Reels manually is OK given the manager
   chose that path over editing the cover in-place.
