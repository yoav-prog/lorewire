# Live runs — pipeline-aware multi-stage status

**Date:** 2026-06-28
**Branch:** `feat/live-runs-multistage` (off `origin/feat/multi-platform-shorts-publisher`)
**Status:** Draft — awaiting approval before code
**Successor:** PR B (story editor per-tab status) reuses this PR's shared data layer.

## The lie we're fixing

PR #129 landed `/admin/reddit-sources/live` showing every story_job's status. Then Yoav saw three cards labeled `DONE` for sources whose short videos and hero thumbnails were nowhere near rendered yet. The card chip reads `story_jobs.status` which only covers **stage 1 of 4**. The pipeline really is:

| # | Stage | Storage column / table | Trigger |
|---|---|---|---|
| 1 | Story job (idea → article → title) | `story_jobs.status` | Python worker |
| 2 | Short render (doodle video) | `short_renders.status` joined via `story_id` | shorts_auto + Cloud Run cron |
| 3 | Hero + thumbnail finisher (i2i from short scenes) | `story_jobs.finisher_status` | `/api/run_hero_thumbnail_finisher` |
| 4 | Auto-publish (only when `full_pipeline=1`) | `story_jobs.auto_publish_status` | `/api/auto_publish_full_pipeline` |

Stages 2–4 fire AFTER stage 1 finishes. A job with `story_jobs.status='done'` and `short_renders.status='rendering'` is NOT finished — the public reader will fall back to a missing hero. Calling that `DONE` on the dashboard is a lie that masks a real backlog.

## Goal

Tell the truth. On Live runs:
- "Active" includes any job with any stage in flight (stage 1 queued/processing, OR short queued/generating/rendering, OR finisher pending/running, OR auto_publish pending).
- "Finished" requires every applicable stage terminal (done / error / failed / skipped).
- Grace window starts when the LAST stage settles, not stage 1.
- Each card shows the per-stage state with a step pill row, so the admin sees "this one is stuck at SHORT" at a glance.

## Non-goals

- No changes to `/admin/stories/[id]` — that's PR B.
- No new stage definitions. We use what the schema already has; we don't introduce a "publish to social" stage or break out short generation vs. render unless they're already separate.
- No mutations on the Live runs page (still read-only).
- No new schema columns or worker writes. The data is already there; we're joining and labeling.

## Architecture

```
   reddit_source  ─┐
   story_jobs     ─┼─ join on story_id /reddit_id
   short_renders  ─┘
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────┐
   │ listActiveJobsWithEvents (server, story-jobs-live.ts)    │
   │   • SELECT story_jobs LEFT JOIN reddit_source            │
   │     LEFT JOIN short_renders ON s.story_id = j.story_id   │
   │     (latest short_renders per story_id only)             │
   │   • WHERE any-stage-in-flight                            │
   │      OR every-stage-settled AND last-settled >= cutoff   │
   │   • SELECT story_job_events for those jobs               │
   │   • Compute per-row stage state in TS, return            │
   │     ActiveJobView with `stages: PipelineStageState[]`    │
   │     + `overall: PipelineOverallState`                    │
   └──────────────────────────────────────────────────────────┘
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────┐
   │ LiveJobCard (client)                                     │
   │   header: title + headline chip (overall) + elapsed      │
   │   pill row: STORY · SHORT · HERO · PUBLISH               │
   │     each pill is pending / running / done / failed /     │
   │     skipped — colored by state                           │
   │   PUBLISH pill hidden when full_pipeline=0               │
   │   collapsed body: latest event line                      │
   │   expanded body: full event log (unchanged from PR #129) │
   └──────────────────────────────────────────────────────────┘
```

### Pure stage-state model (shared, client-safe)

```ts
type PipelineStageId = "story" | "short" | "hero" | "publish";
type PipelineStageState = "pending" | "running" | "done" | "failed" | "skipped";
type PipelineOverallState =
  | "queued"
  | "running"          // ANY stage running (or short queued/generating)
  | "done"             // every applicable stage done
  | "failed"           // ANY applicable stage failed/error
  | "cancelled";       // story stage cancelled

interface PipelineStage {
  id: PipelineStageId;
  state: PipelineStageState;
  /** Human label for the headline chip when this stage is the active one. */
  label: string;
}
```

`computePipelineState(row)` is a pure function over the joined row, lives in `story-jobs-live-shared.ts`, fully unit-tested. The server query produces the row; the function turns it into the array. Both surfaces (Live runs now, story editor later) use the same function so what the dashboard says matches what the editor says.

### "In-flight" predicate (also in shared)

```ts
function isPipelineInFlight(stages: PipelineStage[], fullPipeline: boolean): boolean {
  // Any stage in pending/running state means the pipeline is still in flight.
  // 'skipped' (e.g. publish stage when full_pipeline=0) doesn't count.
  return stages.some((s) => s.state === "pending" || s.state === "running");
}
```

### Last-settled timestamp for the grace window

`computeLastSettledAt(row)` returns the max of `story_jobs.finished_at`, `short_renders.finished_at`, and the timestamp of the latest finisher / auto_publish terminal event (read from `story_job_events`). The query selects jobs where `lastSettled >= cutoff` OR any stage in flight. We do the max in TS, not SQL, to stay portable.

### Stage skip rules

- **Short stage:** `skipped` when `story_jobs.with_media = 0` (the admin opted out of media; legacy path). `pending` when story stage is in flight (short doesn't exist yet, can't be queued until article is). Otherwise driven by `short_renders.status`.
- **Hero stage:** `skipped` when `with_media = 0` OR when the short stage is `skipped` (no scenes to finish from). `pending` when no `finisher_status` yet OR `finisher_status='pending'` and short isn't done. Otherwise driven by `finisher_status`.
- **Publish stage:** `skipped` when `full_pipeline = 0`. Otherwise driven by `auto_publish_status`.

These rules live in `computePipelineState` with test coverage for every combination.

## Files touched

### New / extended

- `lorewire-app/src/lib/story-jobs-live-shared.ts` — add the four types above + `computePipelineState` + `isPipelineInFlight` + `computeLastSettledAt`. Pure, client-safe, no new imports.
- `lorewire-app/src/lib/story-jobs-live.ts` — rewrite `listActiveJobsWithEvents`:
  - Extend the row type to include `with_media`, `full_pipeline`, `finisher_status`, `auto_publish_status` (all already on `story_jobs`).
  - Add a LEFT JOIN to `short_renders` selecting the latest row per `story_id` (use a portable subquery: `(SELECT * FROM short_renders WHERE story_id = j.story_id ORDER BY requested_at DESC LIMIT 1)`).
  - Compute `stages` and `lastSettledAt` per row in TS.
  - In-flight predicate replaces the current `status IN ('queued','processing')` check.
  - Cutoff applied to `lastSettledAt`, not `finished_at`.
  - Same 50-job / 50-events caps.
- `lorewire-app/src/app/admin/(panel)/reddit-sources/live/LiveJobCard.tsx` — replace single status chip with: headline chip (overall) + 4-pill row (STORY/SHORT/HERO/PUBLISH). PUBLISH hidden when stages reports it `skipped`. Latest event line + expand-for-log unchanged.
- `lorewire-app/src/app/admin/(panel)/reddit-sources/live/LiveRunsClient.tsx` — counters use `isPipelineInFlight` instead of the old status check.

### Tests

- `lorewire-app/src/lib/story-jobs-live-shared.test.ts` (new) — covers `computePipelineState` for every realistic combination (story queued; story processing; story done + short queued; story done + short rendering; story done + short done + finisher pending; full_pipeline on with each auto_publish state; with_media=0 skip path; error in each stage). `isPipelineInFlight` truth table. `computeLastSettledAt` for "max of N nullable timestamps."
- `lorewire-app/src/lib/story-jobs-live.test.ts` (extend) — add seed helpers for short_renders rows; tests for: short still rendering keeps the job active even when story_jobs.status='done'; finisher pending keeps it active; auto_publish pending keeps full_pipeline jobs active; grace window starts when the latest stage settles; with_media=0 jobs skip stages 2/3 and the job settles right after stage 1.
- `lorewire-app/src/app/admin/(panel)/reddit-sources/live/LiveJobCard.test.tsx` (extend) — renders 4 pills with correct labels; PUBLISH pill hidden when skipped; headline chip reflects overall state; backwards-compat fallback when stages array is missing (defensive).

## Security (rule 13)

Unchanged. Same `requireCapability("content.manage")` gate at the action + page. Same payload caps (50 jobs / 50 events / no payload contents in browser logs). Adding two columns (`finisher_status`, `auto_publish_status`) + a join to `short_renders` doesn't expose anything secret — they're already visible on the per-row review page.

## Observability (rule 14)

Same console.info namespaces as PR #129. The poll log gains one field: per-tick distribution of overall states.

```
[reddit-sources live poll] { job_count, event_count, duration_ms,
                             by_overall: { running: 5, done: 1, failed: 0 } }
```

No payload contents are echoed. Counts only.

Server-side: `listActiveJobsWithEvents` action log gains `by_stage: { story_pending, short_running, hero_pending, publish_pending }` so we can grep production logs for "stuck at X" patterns.

## Settings audit (rule 15)

No new user-facing settings. The grace window stays 15 min (Yoav locked this in PR #129). Pill labels are hardcoded. The PUBLISH pill is conditionally shown based on `full_pipeline` per source — that toggle already lives on the Reddit Sources list and doesn't need a duplicate setting.

## Testing (rule 18)

- All new + extended unit tests above green.
- Full `npm test` green for the whole suite (subject to the same 2 pre-existing baseline failures that pre-date this branch — verified by stashing).
- `npm run build` green locally. Same Turbopack gotcha we hit in PR #129: any new shared file must NOT import `server-only`. The new types + helpers live in `-shared.ts` exactly to avoid that boundary.
- Manual smoke test:
  1. Queue a fresh row with `full_pipeline=1`. Watch the card progress through 4 stage pills.
  2. Queue a row with `with_media=0`. Verify SHORT + HERO pills render as `skipped` and the job settles immediately after STORY.
  3. Force a short render failure (cancel the short). Verify headline chip turns red with "ERROR @ short" and the job stays on the page for the grace window.
  4. Verify a job with `story_jobs.status='done'` but `short_renders.status='rendering'` no longer disappears after 15 minutes — it stays active until the short and finisher both finish.

## Deploy (rule 19)

- Branch `feat/live-runs-multistage` off `origin/feat/multi-platform-shorts-publisher` (current Vercel production source — verified `git fetch` clean).
- 4 commits, one per concern: shared model + tests / server query + tests / card UI + tests / client counters + tests.
- Push, open PR targeting `feat/multi-platform-shorts-publisher`.
- **Do not promote the Vercel preview to production manually.** Manual promotion bypasses Production Branch tracking (the 2026-06-23 incident). Production deploys via the standard merge into the production source.
- Rollback path: pure additive change. Revert the merge commit. No schema, no data migration, no env vars.

## Alternatives rejected

- **Just rename the chip text** (Option B from chat) — half a fix. The whole point is "see WHERE the holdup is at a glance," which a single chip can't deliver.
- **Tree of 4 mini-cards** (Option C from chat) — a 10-row batch becomes a wall. Pill row is the right density.
- **Add a new schema column for "overall pipeline state"** — would require worker + cron writes everywhere a stage transitions. Cheap to skip: compute it from existing columns. If the formula gets too hot to re-derive per request, we add the denorm column later.

## Open questions

None. Yoav approved Option A (step pill row) and signed off on the scope of "no new schema." Splitting story-editor work into PR B is the call I'm making per the no-clarifying-questions instruction; redirect if you'd rather combine.
