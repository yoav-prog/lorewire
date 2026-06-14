# Pipeline cache column — separate `stories.pipeline_cache` from editor `video_config`

Date: 2026-06-14
Owner: Yoav
Status: DRAFT — awaiting LLM Council pass + approval before code lands.

## Problem

The "All scene images" bulk regen on story `envelope` stalled at 1/27 done. Every
re-claim of scene:1 burned a full world-bible build (~$0.30, 260s), hit the 270s
cron deadline, got reaped at 180s, and the cycle restarted forever.

### What the cron logs actually show

```
05:23:13 [claim] scene:0           ← bible build starts
05:28:13 [claim] scene:0           ← stale reap, fresh attempt
05:32:34 [done]  scene:0   $0.30   ← bible + 1 scene image persisted
05:32:36 [claim] scene:1           ← should hit cached bible
05:33:13 [claim] scene:2           ← also re-claims with cache miss
05:38:14 [claim] scene:1           ← reaped + re-claimed, still cache miss
05:43:13 [claim] scene:1           ← repeats
05:48:13 [claim] scene:1           ← repeats
```

DB peek at 05:51 confirms `stories.envelope.video_config` has NO `world_bible`,
NO `scene_prompts`, NO `scene_prompts_built_with`, NO `scene_entity_ids`. The
story row's `updated_at` is 19 minutes AFTER scene:0 persisted those fields.

### Root cause

The pipeline writes its caches into the same `stories.video_config` JSON column
the video editor owns:

| Field                       | Writer                                    |
|-----------------------------|-------------------------------------------|
| `world_bible`               | `pipeline/media.py:_persist_world_bible`  |
| `scene_prompts`             | `pipeline/media.py:_write_cached_scene_prompts` |
| `scene_prompts_built_with`  | same                                      |
| `scene_entity_ids`          | same                                      |
| `character_bible` (legacy)  | same                                      |

The editor surface treats `video_config` as exclusively its own typed shape.
`parseVideoConfig` in `lorewire-app/src/lib/video-config.ts:140` is strict:

> Unknown top-level fields are silently dropped — that's the council's "the
> renderer treats unknown fields as no-ops" boundary, enforced here so the
> schema can grow without coordinated deploys.

Every editor server action round-trips through it and writes back:

- `saveVideoConfigPatch` — manual save
- `claimEditSession` — mount, take-over
- `heartbeatEditSession` — periodic, while the page is open

Each call reads `video_config`, parses it (strips `world_bible`, etc.), and
writes the stripped JSON back. With the story editor tab open during a Rebuild
batch, the heartbeat wipes the pipeline cache within seconds of scene:0
finishing. scene:1+ cache-miss forever.

## Goals

1. The editor never silently drops pipeline-owned data when it round-trips
   `stories`.
2. The pipeline's caches are durable across editor saves, heartbeats, and any
   future editor actions, without each new server action having to remember to
   merge them back.
3. `envelope`'s in-flight stuck batch gets unstuck. (Out of scope for the
   long-term fix but in scope for the change set.)
4. Loud signal when this regression class shows up again.

## Constraints

- The pipeline runs on both SQLite (local dev) and Postgres (production). Both
  schemas live side-by-side: `lorewire-app/src/lib/schema.ts` for TS,
  `pipeline/store.py` for Python. Migrations must work in both.
- The Vercel Python runtime vendors `pipeline/` via the prebuild step. Any
  change to `pipeline/store.py`'s read/write surface needs to land before the
  TS deploy that reads the new column on the admin side.
- The admin UI is live. A failed deploy leaves the cron in its current
  broken-loop state, which is burning kie credits. Migration plan must
  preserve forward motion for in-flight batches.
- Per CLAUDE.md rule 17, no model-selection decisions involved. Per rule 8,
  cost: one wasted scene:1 cycle is ~$0.30. The change set itself doesn't
  introduce new paid surface — it removes an unintended wipe of paid output.

## Requirements

1. New column `stories.pipeline_cache` (TEXT for portability, holds JSON).
2. The pipeline writes/reads all five fields (`world_bible`, `scene_prompts`,
   `scene_prompts_built_with`, `scene_entity_ids`, `character_bible`) to/from
   `pipeline_cache` going forward.
3. One-shot migration: any existing row whose `video_config` contains any of
   the five fields gets those fields moved to `pipeline_cache` and dropped
   from `video_config`.
4. `parseVideoConfig` does not change. The editor stays oblivious to the
   pipeline cache. No new pass-through, no allowlist.
5. The admin story page does not need to read `pipeline_cache` — it's purely
   pipeline-internal. Reads stay scoped to `pipeline/media.py` and
   `pipeline/world_bible.py`.
6. A new observability signal: when `_regen_one_scene` cache-misses on
   `world_bible` for an index > 0 within a single batch (the regression
   shape), log a `[scene regen cache-wiped]` warn and emit an
   `image_render_events` row with `level='warn'`. The admin UI surfaces it
   inline so the user sees the regression instead of a silent loop.
7. The `envelope` batch is unstuck before close: scene:1..26 cancelled by
   running `clear_stuck_image_renders.mjs` (or a focused script), editor tab
   closed, Rebuild re-clicked after deploy.

## Approach

### Phase 1 — schema

`lorewire-app/src/lib/schema.ts` `STORIES` table: append
`{ name: "pipeline_cache", type: "TEXT" }`. Same column in
`pipeline/store.py`'s schema-init path (whatever ensures the column on first
boot). The TS `ensureSchema` ALTER TABLE adds the column when absent on
production Postgres; the Python `init` does the same on the SQLite side.

### Phase 2 — Python read/write migration

`pipeline/store.py`:

- New helpers: `read_story_pipeline_cache(story_id) -> dict`,
  `update_story_pipeline_cache(story_id, cache: dict) -> None`. Same JSON
  serialisation pattern as `update_story_video_config`. They UPDATE
  `pipeline_cache` only — `video_config` untouched.
- `fetch_story` already returns the whole row, so it just picks up the new
  column. No call-site change.

`pipeline/media.py`:

- `_persist_world_bible` → reads `pipeline_cache`, merges `world_bible`,
  writes back via the new helper. No longer touches `video_config`.
- `_write_cached_scene_prompts` → same shape, writes
  `scene_prompts`, `scene_prompts_built_with`, `scene_entity_ids`,
  `character_bible` into `pipeline_cache`.
- `_read_cached_scene_prompts_with_marker`, `_read_cached_scene_entity_ids`,
  `_read_cached_character_bible` → read from `pipeline_cache` instead of
  `video_config`.
- `_read_world_bible_from_story` (delegates to `pipeline/world_bible.py`) →
  the helper there reads from `pipeline_cache`.

`pipeline/world_bible.py`:

- `read_world_bible(story)` reads from `story["pipeline_cache"]` instead of
  `story["video_config"]`.

### Phase 3 — TS-side cache cleanup path

`lorewire-app/src/lib/image-render-queue.ts` `clearStoryScenePromptsCache`:

- Currently strips cache fields from `video_config`. New behavior: it writes
  an empty (or pruned) `pipeline_cache`. Easier: `UPDATE stories SET
  pipeline_cache = NULL WHERE id = ?` when the user clicks Rebuild.
- The `video_config` mutation that lived in this helper goes away entirely.

### Phase 4 — backfill migration

A one-shot SQL script in `_plans/` (and a parallel `.mjs` runner) that:

```sql
UPDATE stories
   SET pipeline_cache = jsonb_strip_nulls(
         jsonb_build_object(
           'world_bible',              video_config::jsonb -> 'world_bible',
           'scene_prompts',            video_config::jsonb -> 'scene_prompts',
           'scene_prompts_built_with', video_config::jsonb -> 'scene_prompts_built_with',
           'scene_entity_ids',         video_config::jsonb -> 'scene_entity_ids',
           'character_bible',          video_config::jsonb -> 'character_bible'
         )
       )::text,
       video_config = (video_config::jsonb
                       - 'world_bible'
                       - 'scene_prompts'
                       - 'scene_prompts_built_with'
                       - 'scene_entity_ids'
                       - 'character_bible')::text
 WHERE video_config IS NOT NULL
   AND video_config::jsonb ?| ARRAY[
         'world_bible','scene_prompts','scene_prompts_built_with',
         'scene_entity_ids','character_bible'
       ];
```

(Idempotent — the WHERE clause makes a second run a no-op.)

SQLite equivalent inside the script handles dev parity. Both runs print a
count of rows touched so the deploy log shows the migration's blast radius.

### Phase 5 — observability for regressions

`pipeline/media.py:_regen_one_scene`:

- Before calling `_resolve_scene_entries_world_bible`, snapshot whether
  `pipeline_cache` already has `world_bible`. If `index > 0` AND the snapshot
  says yes BUT the resolver still goes through `_ensure_world_bible_with_refs`
  (i.e. cache lookup returned None), emit
  `store.log_render_event("cache_wiped", "world_bible missing for scene:N>0
  — another process wiped it mid-batch", level="warn")`.
- Plain print at `[scene regen cache-wiped]` namespace for grep parity.

### Phase 6 — unblock envelope (out-of-band, but bundled in this commit)

Two extra scripts:

- `scripts/cancel_scene_batch.mjs <story_id>` — sets scene:1..N for the most
  recent batch to status='cancelled' with a reason "supplanted by post-fix
  rebuild". Read-then-write so the user sees the cancelled count before
  applying. Confirms via prompt before mutating, unless `--yes` is passed.
- The existing `scripts/clear_stuck_image_renders.mjs` may already cover
  this; if it does, the new script is unnecessary. Check first.

## Alternatives rejected

- **Option A — allowlist in `parseVideoConfig`**: smallest change, but every
  future pipeline cache field has to be added to the allowlist by hand. The
  abstraction leak says it loud and clear by needing constant maintenance.
- **Option B — merge pipeline fields back at each save site**: same hazard,
  worse coverage. Three sites today, more tomorrow. A new editor action that
  forgets the merge re-introduces this exact bug silently.
- **Per-field columns** (`stories.world_bible`, `stories.scene_prompts`…):
  schema bloat. The fields have to grow together (e.g. a new
  `scene_entity_ids` shape was added in 2026-06-14 Option C); one JSON column
  keeps that natural.
- **Move the editor data instead** (`stories.editor_config`): bigger blast
  radius. The pipeline + renderer + admin read `video_config` extensively
  today. The right cleavage is "isolate the new, smaller, pipeline-internal
  surface" not "move the heavy hitter".

## Security (rule 13)

- `pipeline_cache` holds nothing user-facing: world-bible entity names, scene
  prompts, internal markers. No credentials, no PII, no auth state.
- Read/write is server-side only — the column is never serialised to the
  client. Add it to the **deliberate omission list** in `repo.ts`'s
  `LIST_OMIT_COLUMNS` set (joining `body`, `payload`, `alignment`) so list
  endpoints don't accidentally pull a ~30 KB JSON blob into the dashboard
  payload.
- Migration runs through the existing DAL path; no new SQL surface exposed
  to user input.
- The new `cancel_scene_batch.mjs` script is dev-only (reads
  `DATABASE_URL` from `.env.local`), no public reach.

## Observability (rule 14)

- `[scene regen cache-wiped]` log + `image_render_events` row described in
  Phase 5.
- One-time deploy migration logs `[pipeline cache migration]` with the row
  count both during the SQL script run and on first `ensureSchema` boot.
- `peek_world_bible.mjs` already proved its worth in diagnosis — keep it as
  the canonical "is the cache intact" check. Update its output to read from
  `pipeline_cache` not `video_config`.

## Testing (rule 18)

- New unit test: `pipeline/tests/test_pipeline_cache_isolation.py`
  - Story with pipeline cache + video_config → call `_persist_world_bible`
    → assert `world_bible` ends up in `pipeline_cache`, NOT `video_config`.
  - Story with pipeline cache → editor save (simulated by a write to
    `update_story_video_config`) → re-read `pipeline_cache` → world_bible
    still there.
- New integration test on the TS side:
  `lorewire-app/tests/lib/pipeline-cache-survives-editor.test.ts`
  - Seed `pipeline_cache` with a fake bible. Call `saveVideoConfigPatch`
    with a real-shaped patch. Re-read `pipeline_cache` — must still hold the
    bible.
  - Same for `claimEditSession` and `heartbeatEditSession`.
- New unit test: `_regen_one_scene` raises (or logs warn) when cache-miss
  on world_bible for `index > 0`. Mock `_ensure_world_bible_with_refs` to
  fail fast so the test doesn't fire real kie calls.
- Backfill script is exercised by a SQLite test that seeds rows with
  cache fields inside `video_config`, runs the script, asserts post-state.

## Settings (rule 15)

No new user-facing settings. The pipeline cache is invisible to admins —
they only see the resulting scene images and `peek_world_bible.mjs`.

## Open questions

1. Should the `[scene regen cache-wiped]` event also cancel the in-flight
   batch automatically? Current proposal logs the warn and continues, on the
   theory that the bible build succeeds eventually if the editor tab is
   closed. Auto-cancel risks erasing legitimate in-flight work during a
   transient cache miss.
2. The TS-side `clearStoryScenePromptsCache` currently nukes both
   `scene_prompts` and `character_bible` on every Rebuild click. With
   `pipeline_cache` as a single column, do we nuke the whole column (loses
   the `world_bible` cache too — which the user typically WANTS to invalidate
   on a "fresh look" Rebuild) or selectively wipe scene_prompts only? The
   current behavior already implies "fresh look": keep the wipe scope at
   the whole column for Rebuild, document the trade-off.
3. Drizzle isn't in use; schema lives in the hand-rolled `schema.ts` +
   `pipeline/store.py`. Confirm that the `ensureSchema` flow in TS actually
   issues an `ALTER TABLE` for new columns on Postgres production. (It needs
   to — otherwise the deploy reads from a column that doesn't exist.)

## Phase 3 — follow-up structural fixes (not this PR)

The LLM Council's pressure-test surfaced two defects that the column split
does NOT address. Both go in here so the next session can pick them up
without re-deriving the analysis.

### Phase 3.1 — fix the cron re-claim mechanism

**Symptom**: when a single `image_renders` row fails to complete in one cron
tick (e.g. `_regen_one_scene` runs out the 270s `DEADLINE_S`), the next
tick's `reap_stale_image_render_claims` resets it to `queued`, the tick
after that re-claims it, runs it again, hits the same deadline, dies, gets
reaped again. Forever. Each cycle costs ~$0.30 against kie when the work is
a fresh world-bible build. The `envelope` batch consumed at least 4 such
cycles before this PR caught the root cause.

**Why the column split doesn't fix it**: even with `pipeline_cache`
preserving the bible across editor saves, the FIRST scene:0 row still
carries the bible-build cost. If anything else breaks (kie hiccup, network,
a 28-character bible), scene:0 dies and re-enters the same loop without
backoff.

**Sketch**:
- Add an `attempts INTEGER NOT NULL DEFAULT 0` column to `image_renders`.
  `claim_next_image_render` bumps it on every claim.
- `reap_stale_image_render_claims` becomes status-aware: after N attempts
  (N = 2?) on the same row, transition `generating` → `error` with
  `error='exceeded N attempts'` instead of re-queueing. The cron stops
  burning credits and the admin sees a clear "give up" signal.
- Optionally: introduce exponential backoff between reap-and-reclaim, so a
  row with 1 attempt waits 3 minutes, 2 attempts waits 10 minutes, etc.
  Reuses the `image_render_drain_lock` semantics — nothing new on the
  schema side beyond `attempts` and maybe `next_eligible_at`.
- Wire the existing `[scene regen cache-wiped]` event so it also bumps a
  cost counter; when the per-batch counter passes a hard threshold
  (`$0.50` was the Contrarian's suggestion) the whole batch flips to
  `cancelled` and the admin gets a banner. Cost is the actual tripwire,
  not row count.

### Phase 3.2 — promote world bible to a first-class job with a dependency edge

**Symptom**: scene:0 secretly means "build the whole world bible AND
generate one scene image." Two units of work fused into one queue row. If
scene:0 dies before persisting the bible, scenes 1..26 each independently
rebuild it on their next claim — potentially in parallel if the drain ever
parallelises. The First-Principles Thinker flagged this as the "next loaded
gun" once the column-split lands.

**Why the column split doesn't fix it**: separating cache from editor data
keeps the bible from being WIPED, but does nothing about the
"hidden-fused-work" problem. A scene:0 that simply hits a kie 5xx during
the bible build still leaves scenes 1..26 each paying for a fresh bible
attempt.

**Sketch**:
- New table `story_bibles` (or `world_bibles`):
  ```
  story_id TEXT PK
  version   INTEGER         -- bumps on Rebuild click
  status    TEXT             -- queued | building | ready | error
  content   TEXT             -- JSON, same shape as today's world_bible
  started_at, finished_at, cost_cents
  ```
- Bible build moves out of `_regen_one_scene` into its own
  `image_renders` row with `asset='bible'` (or its own queue table).
- `enqueueScenesBulk` enqueues ONE bible row + N scene rows; the scene
  rows carry `depends_on=<bible_row_id>` and the drain refuses to claim
  them until the dependency is `done`.
- The bible row is the only thing that pays the kie cost for the LLM call
  + reference images. Scene rows just generate one image each, predictably
  ~30s, well under the 270s deadline.
- The drain's row cap (currently 3) can grow safely because no row carries
  hidden minutes of work.
- Per CLAUDE.md rule 13: a status-aware bible row also makes "freeze the
  editor while a bible is building" trivial — the page-render reads
  `story_bibles.status` and shows a "world bible rebuilding…" banner that
  disables the heartbeat write path. That's the Expansionist's
  soft-lease coordination primitive at the cheapest possible cost.

### Phase 3.3 — Expansionist's deferred discoveries

Captured here so they don't disappear with the council transcript. None of
these block Phase 3.1 or 3.2; they're the product surface that becomes
possible once the bible is addressable:

- **Bible-as-template**: "new story in this universe" reuses characters +
  locations from another story's bible. Story authoring UX gets a "fork
  from" picker.
- **Entity dedupe library**: characters/locations with the same canonical
  name + a reference image can be deduped across stories so a recurring
  character is generated once.
- **Selective invalidation**: "Rebuild scenes only" vs "Rebuild bible too"
  as a Settings toggle on the Rebuild click. Today's behaviour (always
  wipe the bible on Rebuild) becomes one of two options; the user can
  choose to keep the same characters in fresh scenes.
- **Cache-conflict admin tile**: surface the `[scene regen cache-wiped]`
  events as a metric in the admin dashboard so the regression class is
  visible before the next user notices.
