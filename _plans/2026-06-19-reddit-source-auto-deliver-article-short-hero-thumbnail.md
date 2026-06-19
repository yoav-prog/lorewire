# 2026-06-19 — Reddit source processing: auto-deliver article + short + hero + thumbnail (scene-derived)

## Goal

When the admin clicks "Process N selected" on `/admin/reddit-sources`, each Reddit row should reliably produce **all four artefacts** by the time the row is marked done:

1. A properly built article (title, body, summary, audio, alignment) — already works.
2. A short video — works today **only if the category is enabled**; will become unconditional.
3. A hero image that is character-AND-scene consistent with the short.
4. A thumbnail (new, separate from hero) that is also character-AND-scene consistent with the short.

Today the pipeline already does (1) and (2 with a gate). (3) is half-built (manual "Restyle hero from short character" button at [pipeline/media.py:984](pipeline/media.py#L984)) and (4) does not exist anywhere.

## What we are NOT doing

- Not touching the multi-platform shorts publisher work on the current branch.
- Not redesigning the short generator itself (`pipeline/shorts.py`).
- Not changing the long-form video render.
- Not adding per-platform thumbnails (1280x720 / 1080x1080) — keep scope to one thumbnail asset for now; per-platform variants can layer in later from the same source.

## Decisions (aligned with user 2026-06-19)

| Question | Decision |
|---|---|
| Visual basis | **Hybrid**: character_base_url **plus** a chosen scene URL, both passed as `image_input` to `kie/gpt-image-2-i2i` |
| Thumbnail vs hero | **Separate** — new `thumbnail_image` column (+ landscape variant) on `stories` |
| Shorts gating | **Every Reddit source produces a short** — bypass the category gate from the worker path; keep the global rolling-24h cost cap |
| Timing | **Sequential** — short renders fully, then hero + thumbnail are derived from it |
| Wait strategy | **Inline polling in the worker** — keep it simple, refactor to stage-split only if throughput hurts |
| Scene picker | **LLM picks the most thumbnail-worthy scene** — small dedicated call, ~$0.001, deterministic fallback if it fails |

## Background — what exists today

- Orchestrator: `_default_process()` at [pipeline/story_jobs_worker.py:163](pipeline/story_jobs_worker.py#L163) runs idea → research → article → branded title → audio → `media.generate_media()` → enqueue long-form video → `shorts_auto.maybe_enqueue_short_for_story()`.
- Short enqueue gated by category: [pipeline/shorts_auto.py:91](pipeline/shorts_auto.py#L91) returns `False` and skips when `shorts.auto.enabled` is off for the story's category.
- Short generation persists a `character_base_url` and a `scenes` list (each with `url`, `scene`, `image_prompt`) inside `short_renders.props`.
- Hero-from-short pattern already implemented in `_regen_hero_from_short()` at [pipeline/media.py:984](pipeline/media.py#L984). It does NOT yet take a scene URL — it only passes `character_base_url`.
- Story job event timeline: `story_job_events` table at [pipeline/store.py:219](pipeline/store.py#L219) exists; the worker already writes timeline entries. We will reuse this for new observability events.

## Architecture

```
story_jobs_worker._default_process(claimed_job, reddit_row):
  1. idea → research → article → branded title
  2. media.generate_media() with NEW skip-hero flag (audio + alignment only)
  3. enqueue long-form video render (unchanged)
  4. shorts_auto.maybe_enqueue_short_for_story(force=True)   ← bypass gate
  5. NEW: poll short_renders until status='done' or timeout
  6. NEW: media.generate_hero_and_thumbnail_from_short(story_id)
       a. load short's character_base_url and scenes from props
       b. LLM picks the most thumbnail-worthy scene (or fallback)
       c. generate hero portrait (3:4)  via i2i with [character, hero_scene]
       d. generate hero landscape (16:9) via i2i with [character, hero_scene]
       e. generate thumbnail portrait (3:4)  via i2i with [character, thumb_scene]
       f. generate thumbnail landscape (16:9) via i2i with [character, thumb_scene]
       g. update stories.hero_image, hero_image_landscape, thumbnail_image, thumbnail_image_landscape
  7. mark story_job done
```

## File-by-file changes

### Schema

`pipeline/store.py`, after the existing `hero_image_landscape` ALTERs:

```
ALTER TABLE stories ADD COLUMN IF NOT EXISTS thumbnail_image TEXT
ALTER TABLE stories ADD COLUMN IF NOT EXISTS thumbnail_image_landscape TEXT
```

Add `update_story_thumbnail(story_id, url)` and `update_story_thumbnail_landscape(story_id, url)` mirroring the existing hero writers.

### Short auto-enqueue: add force flag

[pipeline/shorts_auto.py:91](pipeline/shorts_auto.py#L91) — extend `maybe_enqueue_short_for_story`:

- Add `force: bool = False`.
- When `force=True`, skip the `cfg["enabled"]` check (still resolves narration + length defaults, still respects the global 24h cap which is the real cost protection).
- The story_jobs worker calls with `force=True`; the existing "story complete in the CMS" call sites stay at default (no behaviour change for them).

### Skip hero in pre-short media stage

[pipeline/media.py](pipeline/media.py) `generate_media()` lines 519–562 — add a `skip_hero: bool = False` parameter; when set, generate audio + scenes + alignment but skip the t2i hero. The story job will set this so we don't waste an image generation that will be overwritten in step 6.

### New: hero + thumbnail from short

New function `pipeline/media.py::generate_hero_and_thumbnail_from_short(story_id)`:

- Pulls latest done `short_renders` row for the story (reuses `store.latest_short_render_for_story`).
- Loads `props.character_base_url` and `props.scenes` (or `doodle_frames`).
- Calls new `pipeline/stages.py::pick_hero_and_thumbnail_scenes(title, body, scenes)` → returns `{hero_scene_url, thumbnail_scene_url}`.
- For each of the four orientations, calls `stages.make_thumbnail_prompt(..., character_base_url=..., scene_image_url=...)` (extend the existing helper to mention the second reference in the prompt language: "use this scene's framing and mood as inspiration").
- Calls `_generate_with_retry(prompt, ..., aspect_ratio, image_input=[character_base_url, scene_url], model="kie/gpt-image-2-i2i")`.
- Uploads to GCS keys: `hero.png`, `hero_landscape.png`, `thumbnail.png`, `thumbnail_landscape.png`.
- Writes the four columns.

### New: scene picker

`pipeline/stages.py::pick_hero_and_thumbnail_scenes(title, body, scenes) -> dict`:

- Builds a small LLM prompt: title + 1-paragraph body summary + numbered list of `scene` descriptions.
- Asks for two indexes back as JSON: `{"hero_index": int, "thumbnail_index": int}` with reasoning briefly noted.
- Deterministic fallback (network failure or invalid JSON): `hero_index = 0`, `thumbnail_index = len(scenes) // 2`.

### Worker: orchestrate the wait + finisher

[pipeline/story_jobs_worker.py:163](pipeline/story_jobs_worker.py#L163) `_default_process`:

- Call `media.generate_media(skip_hero=True, ...)`.
- Call `shorts_auto.maybe_enqueue_short_for_story(..., requested_by="story_job", force=True)`.
- Poll `store.latest_short_render_for_story(story_id)` in a loop with backoff (3s, 5s, then 10s steady) and a hard ceiling (e.g. 25 minutes). Emit a heartbeat `story_job_event` every 30s while polling.
- On `status='done'`: call `media.generate_hero_and_thumbnail_from_short(story_id)`, mark job done.
- On `status='failed'` or ceiling hit: mark the story job failed with a clear error so the admin's row shows it.

## Security (rule 13)

- New columns store URLs only; no PII, no secrets. Same surface as `hero_image`.
- The `force=True` short enqueue still respects the 24h global cap, so a runaway "Process 1,000 selected" cannot trigger 1,000 paid generations silently.
- The scene picker LLM call sends the article title + short body summary + scene captions. No new external data leaves the system that wasn't already used elsewhere in the article pipeline.
- The i2i calls send the character base image URL and the scene image URL to kie. Both are already stored in our GCS bucket and already sent to kie during short generation — no new data exposure.
- Worker poll loop has a hard ceiling so a stuck short can't tie up a worker slot forever.

## Observability (rule 14)

Per-step `story_job_events` rows so the admin's detail timeline narrates the full life:

- `short_enqueued_for_story` — payload `{render_id, narration, length}`
- `waiting_for_short` — heartbeat every 30s with elapsed seconds
- `short_done_picked_scenes` — payload `{hero_index, thumbnail_index, hero_scene_url, thumbnail_scene_url, picker_reasoning}`
- `hero_from_short_built` — payload `{portrait_url, landscape_url, cost_cents}`
- `thumbnail_from_short_built` — payload `{portrait_url, landscape_url, cost_cents}`
- `short_failed_aborting_finisher` / `short_wait_ceiling_hit` — error rows

`print()` lines (matching the existing `[shorts_auto cap]` style) for tailing:
`[story_job finisher] story={id} waiting on short render_id={...} elapsed=Xs`
`[story_job finisher] story={id} picked hero_scene=#2 thumb_scene=#5`
`[story_job finisher] story={id} hero+thumb done total_cents=X`

## Settings audit (rule 15)

New settings keys (admin Settings page surface):

- `shorts.auto.daily_cap` — already exists; relevant since `force=True` will lean on it harder. Document on the settings page that this now bounds Reddit-source-driven shorts too.
- `hero_thumbnail.wait_ceiling_seconds` — default 1500 (25 min). Knob for ops to extend if cloud-run renders run long.
- `hero_thumbnail.scene_picker.enabled` — default `on`. When `off`, use deterministic fallback (cheaper, free).

Existing `shorts.auto.enabled` and `shorts.auto.category.*` knobs stay — they still apply to the **non-story-job** call sites (e.g., manual "complete in CMS" hooks).

No new admin UI page needed; these live in the existing Settings panel under a "Hero & thumbnail" group.

## Testing (rule 18)

Per `pipeline/` convention (pytest), add:

- `pipeline/tests/test_shorts_auto_force.py` — `maybe_enqueue_short_for_story(force=True)` enqueues even when the category is off, still respects the 24h cap.
- `pipeline/tests/test_scene_picker.py` — `pick_hero_and_thumbnail_scenes` returns valid indexes inside `len(scenes)`; falls back to `(0, len/2)` on bad JSON; returns distinct indexes when at least 2 scenes exist.
- `pipeline/tests/test_hero_thumbnail_from_short.py` — fixture short render with character_base_url + 5 scenes; the generator calls `_generate_with_retry` four times with the correct `image_input=[char, scene]` pairs; writes the four `stories` columns.
- `pipeline/tests/test_story_job_orchestration_waits_for_short.py` — fake `short_renders` row that transitions queued → rendering → done; orchestrator polls, then runs the finisher; on `failed`, story job is marked failed and finisher is skipped; on ceiling, ditto.
- Run the full pipeline test suite (`pytest pipeline/`) and the project test suite from the repo root before calling it done.

## Cost (rule 8)

Per Reddit source processed end-to-end after this change:

| Stage | Calls | Approx cost |
|---|---|---|
| Article + audio | unchanged | unchanged |
| Long-form video | unchanged | unchanged |
| Short (already wired) | unchanged | ~$0.50–0.70 per [shorts_auto.py:23](pipeline/shorts_auto.py#L23) docstring |
| Scene picker LLM | 1 small call | ~$0.001 |
| Hero portrait (i2i) | 1 | ~$0.04 |
| Hero landscape (i2i) | 1 | ~$0.04 |
| Thumbnail portrait (i2i) | 1 | ~$0.04 |
| Thumbnail landscape (i2i) | 1 | ~$0.04 |
| **Added cost per story** | | **~$0.16** |

Today's text-only hero is ~$0.04–0.08; we save that by skipping it. **Net added cost: ~$0.10–0.12 per story.**

The 24h global cap on auto shorts is the existing backstop against runaway "Process 200 selected" → 200 × $0.70 short bills. We are NOT removing it. Per rule 8, real current pricing must be checked at implementation time on the kie pricing page and the LLM provider pricing page — these numbers are sourced from the existing docstrings in this repo and could be stale.

## Open questions — RESOLVED 2026-06-19

1. **Overwrite on re-run** (chosen). Finisher always writes the four fields; no skip-if-populated guard.
2. **1:1 square thumbnail added** (chosen). Thumbnail ships in three orientations: 3:4 portrait, 16:9 landscape, 1:1 square. Hero stays portrait + landscape. Six i2i calls per story (2 hero + 3 thumbnail = 5 — see cost update below) instead of four.
3. **Retroactive admin button added** (chosen). New action on `/admin/stories/[id]` labeled "Generate hero + thumbnail from short" calls the finisher directly so legacy stories with a short but no thumbnail can be backfilled by hand.

## Updated schema

```
ALTER TABLE stories ADD COLUMN IF NOT EXISTS thumbnail_image          TEXT  -- 3:4 portrait
ALTER TABLE stories ADD COLUMN IF NOT EXISTS thumbnail_image_landscape TEXT  -- 16:9 landscape
ALTER TABLE stories ADD COLUMN IF NOT EXISTS thumbnail_image_square    TEXT  -- 1:1 square
```

## Updated cost

| Image call | Count |
|---|---|
| Hero portrait (3:4) i2i | 1 |
| Hero landscape (16:9) i2i | 1 |
| Thumbnail portrait (3:4) i2i | 1 |
| Thumbnail landscape (16:9) i2i | 1 |
| Thumbnail square (1:1) i2i | 1 |
| **Total i2i calls per story** | **5** |

At ~$0.04 each that's **~$0.20 added per story** (minus the ~$0.04–0.08 we save by skipping the old text-only hero) → **net ~$0.12–0.16 per story**. Real prices to be re-checked at implementation time per rule 8.

## Rollback

Each change is additive:

- New columns are nullable; old code paths ignore them.
- `skip_hero` defaults to `False` so the existing `generate_media` callers are unchanged.
- `force` defaults to `False`.
- The finisher function is only called from the new worker code path; reverting the worker change disables the new flow entirely.

A revert is `git revert` on the worker commit; data already written (new column values, new event rows) is harmless to leave in place.
