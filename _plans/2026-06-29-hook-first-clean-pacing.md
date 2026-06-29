# Hook-first shorts: clean cold open + paced intro

Date: 2026-06-29
Owner: Yoav
Status: Approved direction (generation fix approved 2026-06-29); pacing splice
pending implementation + Yoav's sign-off on durations.

## Why this exists

The hook-first splice (`_plans/2026-06-28-hook-before-brand-intro.md`) cuts the
body at `hook_end_ms` and inserts the brand intro there. Two problems surfaced
when reviewing a real render (story `idea_15da45a5bbbd`, hook "She brought a
secret child"):

1. **The hook bleeds across two scenes.** "She brought a secret" is on scene 1
   (restaurant); the payoff word "child" lands on scene 2 (the street walk).
   Scene 2 also carries the next beat ("HOURS EARLIER"). So scene 2's burnt-in
   caption appears before the intro and again after it. There is no frame where
   the full hook has played and scene 2 is not already on screen, so the splice
   alone cannot separate them.
2. **The cut has no breathing room.** The intro slams in the instant the hook
   word ends, and after the intro the story resumes as an abrupt freeze-unfreeze.
   Yoav wants ~1-2s of silence after the hook before the intro, and ~1s after
   the intro before the story resumes.

## Goal

A short opens on the complete spoken hook over a single cold-open scene, holds a
beat of silence, plays the brand intro, holds another beat, then fades into the
rest of the story, then the outro. Every short, not just ones where the hook
happens to align with a scene boundary.

## Change 1 — Generation: first scene spans the whole hook (APPROVED)

File: [pipeline/shorts_render.py](pipeline/shorts_render.py).

`build_short_props` already computes `hook_end_ms` (line ~369) and builds
`doodle_frames` via `_map_frames` (line ~502), where each frame's
`caption_chunk_start_index` indexes into `props["captions"]` (= `caption_chunks`,
line 580). The composition windows frame i from `captions[idx_i].start_ms` to
`captions[idx_{i+1}].start_ms` ([video/src/DoodleShort.tsx:98-126](video/src/DoodleShort.tsx#L98-L126)).
So extending the first scene over the hook = forcing every later scene to start
at or after the first post-hook caption chunk.

New pure helper `_extend_first_scene_over_hook(doodle_frames, caption_chunks,
hook_end_ms) -> (frames, split_ms)`:
- Find the hook's last caption by the chunk whose **END** is nearest
  `hook_end_ms` (the hook ends on a caption boundary; HOOK_END_PAD_MS pushes
  `hook_end_ms` a few frames past it, so "first chunk start >= hook_end_ms"
  snaps to the wrong edge — it left the next line's caption before the intro on
  story `idea_15da45a5bbbd`). `first_post_hook = last_hook_chunk + 1`.
- Shift each frame after the first up to at least `first_post_hook`, preserving
  the strictly-increasing index invariant `_map_frames` set.
- Return `split_ms = caption_chunks[first_post_hook].start_ms` (the scene edge),
  which `build_short_props` writes onto `hook_end_ms` so the splice cuts on the
  scene/caption boundary, not mid-scene.
- No-op when `hook_end_ms <= 0`, fewer than 2 frames, or no post-hook chunk.

Called in `build_short_props` right after the existing pin-to-0 block. Logged
per global rule 14: `[short id=... hook_scene] first scene spans hook; ...`.

Cloud Run passes `doodle_frames` through unchanged
([video/server/render.ts](video/server/render.ts) selectComposition/renderMedia),
so the Python fix is the single source of truth — no TS change for this part.

Result: the restaurant scene now covers "She brought a secret child" (the
"child" caption lands on the restaurant, which is more apt anyway), and the
street scene starts cleanly at "HOURS EARLIER". The splice at `hook_end_ms` then
separates hook from rest with no caption bleed.

## Change 2 — Splice pacing: fades + silence (PENDING durations sign-off)

Files: [pipeline/segments.py](pipeline/segments.py)
`_ffmpeg_splice_cmd_hook_first`, and [video/server/ffmpeg.ts](video/server/ffmpeg.ts)
`buildHookFirstArgv` (kept byte-equivalent).

Today the hook-first argv concats `[body_hook][intro][body_rest][outro]` with a
hard cut at each seam. New behaviour, validated frame-by-frame on a real render
(`_proto/example_hold.mp4`, signed off by Yoav 2026-06-29):

- **Hold the hook frame.** `body_hook` plays to `hook_end_sec` (the caption
  edge), then FREEZES that last clean frame while the spoken line finishes — the
  clip's audio runs `HOOK_FIRST_TAIL_HOLD_SEC` (0.3s) longer than its video. This
  is the load-bearing fix: the next line's caption starts right on the caption
  edge, before the last word's audio ends, so freezing before the edge lets
  "...child" finish without the next caption ever appearing. The physical body
  clips split at `hook_end_sec + tail_hold`; `body_rest` resumes there (the
  skipped span played as the frozen frame). Implemented with
  `trim=0:hook_end,setpts,tpad=clone` for the freeze.
- After the freeze the held frame fades to black (`HOOK_FIRST_FADE_SEC` 0.45s)
  and holds black + silence (`HOOK_FIRST_HOOK_GAP_SEC` 1.1s) before the intro.
- The intro holds black + silence (`HOOK_FIRST_INTRO_GAP_SEC` 0.9s).
- `body_rest` fades in over 0.45s (video + audio) so the resume is not an abrupt
  unpause. `tpad=stop_mode=add` is used for the black holds so the beat is pure
  black regardless of the fade's last frame.

Verified: pure silence (-91dB) in both gaps, the held frame stays the hook scene
(not black, no next-line caption), and the spoken sentence completes before the
fade. The four pacing durations are module constants mirrored in
`pipeline/segments.py` and `video/server/ffmpeg.ts`; a `fmtG`/`format(x,"g")`
helper keeps computed values (e.g. `hook_end + tail_hold`) byte-equal across the
two paths. Promoting the constants to admin settings (global rule 15) is a
clean follow-up; shipped as constants for v1 to avoid Vercel->Cloud Run setting
plumbing.

## Alternatives rejected

1. **Splice-only: include scene 2's "child" before the intro.** Quickest, but
   the street image brackets the intro — the exact artifact Yoav flagged.
2. **Splice-only: freeze the restaurant through "child".** Full hook audio plays
   but the "CHILD." caption never shows and the held caption reads "SHE BROUGHT
   A SECRET" under the word "child". A hack.
3. **Truncate the hook at the scene boundary.** Pre-intro hook becomes "She
   brought a secret"; the payoff comes after the intro. Breaks the hook.

Change 1 (generation) is the root-cause fix; the splice hacks are all
compromised.

## Testing (global rule 18)

- Python unit tests for `_extend_first_scene_over_hook`: hook spanning 2 scenes
  shifts scene 2 to the first post-hook chunk; multi-scene hooks dedup without
  collisions; no-op on `hook_end_ms=0`, single frame, or no post-hook chunk;
  strictly-increasing invariant preserved; clamps to last caption index.
- Splice argv-shape tests in `pipeline/tests/test_segments.py` and
  `video/server/ffmpeg.test.mjs` for the fade/silence filter graph, mirrored so
  Cloud Run and local renders match.
- Manual: regenerate `idea_15da45a5bbbd`, ffprobe frame 0 (hook scene), the gap
  (pure black, -91dB), and confirm "HOURS EARLIER" appears only after the intro.

## Deploy (global rule 19, lorewire-app/AGENTS.md)

- Change 1 (Python pipeline) ships via the production branch on Vercel — the
  generation drain runs there. No Cloud Run deploy needed for Change 1.
- Change 2 (ffmpeg.ts) needs a Cloud Run redeploy (`cd video; npm run
  deploy:cloud-run`). CAUTION learned 2026-06-29: the deploy script force-pushes
  `.env.local`'s `CRON_SECRET` + `GCS_BUCKET` to the live service. Confirm the
  local `CRON_SECRET` matches Vercel's before deploying, or the dispatcher 401s.
- Existing shorts keep their baked order until regenerated (force Regenerate
  rebuilds props through `build_short_props`; Lane A/B/C reuse baseline props and
  will NOT pick up Change 1).

## Security / observability / settings

- No new auth surface, no new external deps. ffmpeg operates on already-trusted
  normalized inputs.
- Logs: `[short id=... hook_scene] moved ...` (Change 1);
  `[segments splice] mode=hook_first_paced gap_ms=... fade_ms=...` (Change 2).
- Settings: two silence durations + fade length (Change 2), defaults from the
  prototype.

---

## Follow-up: per-video audio tail-hold (added 2026-06-29, shipped on fix/hook-tail-hold-dynamic)

### The bug this fixes

The pacing above held the hook clip's AUDIO a FIXED `HOOK_FIRST_TAIL_HOLD_SEC`
(0.3s) past the cut so the last word finishes over a frozen frame. That assumed
every hook is followed by a pause. It is not. On story `1l39ygh` (hook "Cold
water hit her face again", next line "Twenty years earlier" with NO pause) the
fixed 0.3s reached past the word boundary into the next sentence: you heard
"Twenty..." start, the intro cut it, and `body_rest` resumed mid-sentence. Both
halves clipped. The fixed hold is only safe when the real gap >= the hold.

### The fix

Size the hold PER VIDEO to the real gap before the next spoken word, from the
word-level alignment the pipeline already has:

- `next_word_start_after_hook_ms(hook, words)` (pipeline/shorts_render.py): walks
  the alignment the same way `compute_hook_end_ms` does and returns the START
  (ms) of the first spoken word AFTER the hook. None when the hook can't be
  matched or is the last thing spoken.
- `compute_hook_tail_hold_ms(hook, words, hook_end_ms)`: hold =
  `clamp(next_word_start - hook_end_ms, 0, HOOK_TAIL_HOLD_MAX_MS=300)`. Gap 0
  (hook butts into the next line) -> 0 hold, so the cut lands exactly on the word
  boundary and never clips the next sentence. Gap with a pause -> hold up to the
  cap. No alignment match -> the constant max (legacy fallback).
- `build_short_props` stores it on `props["hook_tail_hold_ms"]` next to
  `hook_end_ms`.

### Plumbing (mirrors hook_end_ms end to end)

- Dispatcher (`api/render_short/route.ts`): `extractHookTailHoldSecFromProps`
  pulls + strips `hook_tail_hold_ms` (0 is VALID here, unlike hook_end_ms where 0
  means "no hook") and forwards `segments.hookTailHoldSec` only when the reorder
  is active (`hookEndSec != null && intro`).
- Cloud Run parse (`video/server/index.ts:parseSegments`): accepts
  `hookTailHoldSec >= 0`; missing/negative leaves it unset.
- Cloud Run render (`video/server/render.ts`): `tailHoldSec =
  segments.hookTailHoldSec ?? HOOK_FIRST_TAIL_HOLD_SEC` (per-video value, else
  the constant) -> `buildConcatArgv`. The argv math in `ffmpeg.ts` is unchanged,
  so byte-equivalence with `pipeline/segments.py` holds for any given hold value.
- `pipeline/segments.py:splice` gains an optional `hook_tail_hold_sec` (None ->
  constant) for parity; no live shorts caller passes it (shorts splice only on
  Cloud Run; video.py is long-form and never opts into hook-first).

### Tests

- Python `HookTailHoldTests` (test_shorts_render.py): next-word lookup (found /
  last-word / no-match / empty); hold = 0 on the no-pause 1l39ygh shape, capped
  on a 500ms pause, verbatim on a 150ms gap, max-fallback when no next word,
  clamps a negative gap to 0.
- TS `extractHookTailHoldSecFromProps` (route.test.ts): 0 survives as a real
  value, positive -> seconds + strip, missing -> null, malformed -> null+strip.
- TS `parseSegments` (index.test.mjs): `hookTailHoldSec` passes through incl. 0;
  drops negative / non-finite / wrong-type.

### Deploy

Same split as Change 1/2: the Python compute + dispatcher forward ship via the
Vercel production branch; the render.ts/index.ts change needs a Cloud Run
redeploy. Until Cloud Run is redeployed, it falls back to the constant hold
(safe, just the old behavior). Old shorts keep their baked hold until
regenerated.
