# Scene image prompts grounded in narration (Option B)

**Date:** 2026-06-14
**Status:** Approved by user, council skipped per user choice.
**Files I expect to touch:**
- `pipeline/stages.py` — extend `make_image_prompts` to accept per-scene
  narration lines and a character bible; rename/expose a new entry point.
- `pipeline/media.py` — pass narration into the prompt builder; drop the
  cache key on every regen path that's NOT a same-batch refill; persist the
  per-scene prompt into `video_config.scene_prompts` and (where present) the
  corresponding `doodle_frames[i].image_prompt`.
- `lorewire-app/src/app/admin/(panel)/stories/[id]/page.tsx` — pass
  `prompt` through to `GranularRegenGrid` so the lightbox modal shows the
  real prompt instead of "no prompt captured."
- `lorewire-app/src/app/admin/(panel)/_components/GranularRegenGrid.tsx` —
  none (already accepts `prompt`).
- Tests on both sides.

---

## Goal

Make scene images match what the narrator is actually saying at that
moment in the video, and make the lightbox modal show the exact prompt
that produced each image so we can verify it without leaving the page.

## Success looks like

1. Click "Redo" on Scene 7 of any story; the image that comes back depicts
   the narrated content at the Scene 7 timestamp, not a generic "scene
   from the article."
2. Click the Scene 7 thumbnail; the lightbox opens with the full image and
   the actual prompt that was sent to kie.ai shown alongside it, copyable.
3. Stories whose `video_config.scene_prompts` cache was populated before
   this change can recover: the first regen on each story overwrites the
   cache with fresh, narration-grounded prompts.

## What I will not do in this PR

- Building an admin "review prompts before fire" surface (that's Option C).
- Touching the hero, props, or mouth-swap prompt paths. Only the scene
  path is in scope.
- Touching the article (non-video) image path. The complaint and the
  cache-poisoning bug are both video-only.

---

## Root causes (from the investigation in chat)

1. **Cache poisoning.** `_resolve_scene_prompts_cached` returns the cached
   list whenever it's at least as long as `scene_count`. Per-image "Redo"
   keeps hitting that cache. Any story whose cache was populated when
   `make_image_prompts` truncated mid-array (the pre-`f233d3b` 4000-token
   bug) is permanently stuck on generic prompts until something explicitly
   clears the key.
2. **Loose binding to script.** `make_image_prompts(idea, body, n)` asks
   the LLM to imagine N scenes from the full article body. Nothing pins
   scene N's prompt to scene N's narration line. Same article, slightly
   different N, completely different visual story.
3. **Lightbox shows nothing.** `sceneGranular` in `stories/[id]/page.tsx`
   never passes `prompt`, so the GranularImageCard modal — which already
   has a beautiful prompt panel — always shows "no prompt captured."

## Why these three add up to the user's symptom

The user sees stick-figure-on-a-cliff for a scene where the narrator says
something completely unrelated. They can't open the image to see what
prompt produced it, and they can't escape the cached prompt by clicking
Redo. From their seat, the per-image regen is broken.

---

## The new shape

### Per-scene narration anchor

Each `DoodleFrame` already carries `caption_chunk_start_index`. The
narration text for scene `i` is:
`captions[frame[i].caption_chunk_start_index ... frame[i+1].caption_chunk_start_index - 1].text` joined.
For the last frame, slice to end of captions.

Pipeline side, this means `_regen_one_scene` (and `_regen_scenes`, and
the cache resolver) must read `video_config.doodle_frames` +
`video_config.captions` to build a `scene_narrations: list[str]` of
length `scene_count` and pass it to the prompt builder.

### New prompt-build entry point

Replace the current `make_image_prompts(idea, body, dry_run, n)` for the
video path with `make_grounded_scene_prompts(idea, body, scene_narrations,
dry_run)`. Behavior:

1. **Character bible step.** One LLM call: given `idea` + `body`, return a
   JSON object `{ characters: [{name, visual_cues}, ...] }` with 2–4
   recurring characters. Cached on `video_config.character_bible` so we
   only pay for it once per story.
2. **Per-scene prompt step.** Single LLM call: pass the character bible
   + `scene_narrations` (numbered list) and ask for exactly
   `len(scene_narrations)` prompts, one per scene, each grounded in its
   narration line and reusing the bible's visual cues verbatim where a
   character is on-screen. Style suffix appended verbatim, same as today.

Return shape: `list[str]` of length `scene_count`. The hero slot is gone
from this path — the hero already has its own prompt builder. (Today's
`make_image_prompts` returns hero+N and callers throw away index 0; the
new entry skips that waste.)

`make_image_prompts` itself stays so the article path and the legacy
callers don't break, but the video path stops using it.

### Cache key, per-image Redo, and bulk Rebuild

`video_config.scene_prompts` becomes "the prompts that produced the
images currently on disk." Invariant: a Redo on scene i rewrites
`scene_prompts[i]` to the prompt that was actually used.

- **Bulk Rebuild-all-scenes:** clear the cache (already does this on the TS
  side) → `_regen_scenes` rebuilds the full list with grounded prompts.
- **Per-image Redo (`scene:N`):** still consult cache. If `scene_prompts`
  exists AND was built grounded (has a `built_with: "narration_v1"` marker
  on `video_config`), reuse `scene_prompts[N]` for character continuity
  with neighbors. Otherwise treat as cache miss and rebuild the full list.
  The `built_with` marker is how legacy/poisoned caches get evicted on
  first contact.
- After the kie call lands, `_persist_frame_prompt`-style write updates
  `scene_prompts[N]` and, if the story has `doodle_frames`, also
  `doodle_frames[N].image_prompt`. Two writes, one source of truth.

### UI wiring

`stories/[id]/page.tsx` reads `s.video_config` (already in scope), parses
the JSON, pulls `scene_prompts: string[]`, and passes
`prompt: scene_prompts[i] ?? ""` into each `sceneGranular` item. The
modal already handles empty.

---

## Security (rule 13)

- **No new attack surface.** All new inputs come from the existing story
  row (already trusted, already validated). The LLM call uses the same
  `llm.chat` wrapper as the rest of the pipeline.
- **Prompt-length caps.** Per-scene narration is bounded by caption text,
  which is human-narratable in seconds, so a single scene line is
  always tens of words, not a paste-bomb. Still, when we build the LLM
  instruction, cap each narration line at 600 chars defensively (a
  malformed `captions` field shouldn't drive an unbounded LLM bill).
- **Character bible JSON parse.** Same defensive parser as
  `_parse_prompt_list` — bad JSON falls through to a "no bible" branch
  rather than crashing, and the per-scene step still runs (just without
  the continuity reinforcement).
- **No PII in the prompt panel.** The lightbox just renders what we sent;
  it doesn't introduce a new sink. The prompts already exist in the DB.

## Observability (rule 14)

Every step gets a namespaced print so when a regen produces a "wrong"
image we can read what the LLM saw and what kie got:

- `[scene prompts bible] story={id} characters={names} cached={true|false}`
- `[scene prompts grounded] story={id} count={n} truncated={bool} fallback_used={bool}`
- `[scene prompts cache hit grounded] story={id} count={n}` — only when
  the `built_with` marker matches.
- `[scene prompts cache evict legacy] story={id} reason={no_marker|short}`
  — fires when a pre-this-change cache is dropped, so we can watch the
  rollout drain stale entries.
- `[regen scene grounded] story={id} index={N} prompt_hash={sha8} chars={len}`
  before the kie call. Prompt hash + length is enough to diagnose
  "wrong image" without leaking the full prompt into noisy logs.

On the TS side, the lightbox already logs `[granular image card copy]`;
no new client logs required.

## Settings audit (rule 15)

- **`video.scene_prompt_grounding` (new, default `on`).** Turning it off
  reverts to the old `make_image_prompts(idea, body, n)` behavior. Useful
  as an escape hatch if the grounded prompts somehow over-fit or break
  for a specific story. Goes in Settings → Generation.
- **`video.character_bible_cache` (new, default `on`).** Off forces a
  fresh bible on every regen — diagnostic-only; surface as a small
  "Advanced" toggle under the grounding switch.
- Both default-on. The "lazy user" (rule 10) gets the better quality with
  zero clicks; the power user has the escape hatch when they need it.
- No new color/font/density choices to expose — all server-side prompt
  shape work.

## Testing (rule 18)

Non-negotiable. Each item ships with a test before I call this done.

- `pipeline/tests/test_stages_grounded_prompts.py` (new)
  - `make_grounded_scene_prompts` dry-run returns N deterministic stubs
    in the same length as `scene_narrations`.
  - Real-call path parses the bible JSON, builds per-scene prompts, and
    every prompt contains its scene's narration keyword.
  - Bible parse failure: falls through to a per-scene prompt without the
    bible but still grounded in the narration line.
  - Per-scene prompt parse failure: falls through to a story-grounded
    fallback that mentions the narration line — never returns the old
    "Scene N from the story above" generic.
- `pipeline/tests/test_media_regen.py` (extend)
  - `_resolve_scene_prompts_cached` evicts a cache that lacks the
    `built_with: "narration_v1"` marker.
  - Per-image Redo on a story with a grounded cache reuses
    `scene_prompts[N]` (no LLM call).
  - Per-image Redo on a story with no doodle_frames still works (article
    legacy path) — wait, in scope check: out of scope for this PR.
    Add an `assert_pipeline_skips_video_scope` guard test instead so a
    future change can't silently break it.
  - `_persist_scene_prompt` writes both `scene_prompts[N]` and
    `doodle_frames[N].image_prompt` when frames exist.
- `lorewire-app/src/app/admin/(panel)/_components/GranularImageCard.test.tsx`
  (new or extend) — modal renders `prompt` when supplied, renders the
  empty-state message when blank. Copy button writes to clipboard.
- `lorewire-app/src/app/admin/(panel)/stories/[id]/page.test.tsx` — out
  of scope (server component, no harness today).
- Manual QA pass on a real story after the rollout: open lightbox, copy
  prompt, paste into editor, confirm it reads grounded; click Redo, watch
  the new prompt and image arrive.

## Open questions

1. **Does the new entry point belong in `stages.py` or a new
   `pipeline/scene_prompts.py`?** Leaning `stages.py` to keep callers
   stable; will revisit if the file gets unwieldy.
2. **Do we structure-output the LLM call?** Today's call uses a long
   instruction + post-hoc JSON parse. A schema'd structured-output call
   would be more robust against the truncation class of bug we just
   fixed. Out of scope for this PR unless the JSON parsing turns out
   flaky in tests — then we revisit.
3. **What happens if a story has captions but no doodle_frames yet?**
   (Old stories generated before the doodle_frames Phase 2 migration.)
   The new builder requires `scene_narrations`; without frames we fall
   back to the current `make_image_prompts(idea, body, n)` path so legacy
   stories keep working. Logged as `[scene prompts grounded] fallback=legacy`.

## Alternatives rejected

- **Option A (minimal cache invalidation + UI wire).** Would unblock the
  poisoned-cache stories but leave the loose-binding problem in place. We
  would be back here in a week.
- **Option C (full audit-before-fire flow).** Right destination, wrong
  next step. Two to three days of work, introduces a queue state, an
  approval UI, and a new failure mode (admin walks away mid-approval).
  Build it once we have evidence Option B isn't enough.
