# Unified Live Runs + Stop Runs

**Date:** 2026-07-03
**Status:** approved (Yoav, in chat: "add an option here to stop runs" + "in the Live Runs page i want to see all runs, not only those from reddit sources. categorise them ... with robust filters and search")

## Goal

1. The Live Runs page shows EVERY kind of run, categorised: pipeline story
   jobs, hero+thumbnail finishers, short renders, image renders, voice
   renders, and refresh-assets chains. Filters by kind and status, plus a
   search box (title / id / asset), plus the existing active-vs-recent
   window.
2. Runs can be stopped: per-run Stop on the Live Runs page, and a bulk
   STOP RUNS action in the /admin/content bulk bar that cancels everything
   in flight for the selected stories.

## Design

### Read layer: `lib/runs.ts` (server-only)

One normalized `UnifiedRun` shape: kind, id, storyId, storyTitle, label
(asset / voice / phase), status (queued | running | done | error |
cancelled), progress, requestedAt / startedAt / finishedAt, error.
`listRuns(windowMinutes)` unions:

- `story_jobs` (kind `pipeline`): queued/processing + finished within the
  window. The page KEEPS the existing LiveJobCard event stream for these.
- `story_jobs.finisher_status` (kind `finisher`): pending/running +
  recently done/failed rows.
- `image_renders` (kind `image`): queued/generating + recent, label = asset.
- `voice_renders` (kind `voice`): queued/processing + recent.
- `short_renders` (kind `short`): queued/rendering + recent, phase +
  progress passthrough.
- `stories.refresh_assets_state` (kind `refresh`): non-null state rows.

Titles come from one batched stories lookup. Everything is bounded by the
window + per-kind caps, so kind/status/search filtering happens client-side
on the polled snapshot (robust and instant, no query churn).

### Stop layer: `stopRuns(storyIds)` in `lib/runs.ts`

Per story, soft-cancel with the same guarded-UPDATE discipline the image
queue established (cancel only claimable states; racing transitions no-op):

- image_renders: existing `cancelAllImageRendersForOwner`.
- voice_renders: queued/processing -> cancelled ('cancelled' already in the
  status union; the Python worker claims only queued rows).
- short_renders: queued/rendering -> cancelled (Cloud Run's finish write is
  guarded `WHERE status='rendering'`, so a late result is discarded).
- story_jobs: existing `bulkCancelActiveStoryJobs` (resets source rows).
- finisher: pending -> NULL (unarmed before any claim); running rows are
  left alone (a Vercel function mid-flight cannot be interrupted).
- refresh_assets_state: cleared.

Single-run stop (`stopRun(kind, id)`) reuses the same guards per kind.

### UI

- Live Runs page (`reddit-sources/live`): filter bar (kind chips with live
  counts, status chips, search input, window select), then runs grouped by
  kind with headers. Pipeline rows keep the full LiveJobCard (event log
  streaming); other kinds render compact rows with status/phase/progress/
  error + a Stop button on stoppable states. Poll cadence unchanged (2s
  focused).
- /admin/content bulk bar: STOP RUNS button -> `bulkStopRunsAction`
  (selected stories) -> result banner with per-kind cancel counts.

## Security

All new actions behind `requireCapability("content.manage")`. Stop writes
are guarded UPDATEs on closed status sets; no free-text reaches SQL except
the cancel reason (parameterised).

## Observability

`[runs list]` (counts per kind), `[runs stop]` (story ids + per-kind
counts), `[content bulk stop]` (start/done). Cancelled rows carry a
human-readable reason in their error column.

## Testing

- lib/runs list: seeded rows of each kind appear with the right kind/
  status; window excludes old finished rows.
- stopRuns: queued image/voice/short rows flip to cancelled; done rows
  untouched; finisher pending unarmed; refresh state cleared.
- bulkStopRunsAction: capability-gated, per-story counts, article rows
  rejected.

## Out of scope

- Interrupting an in-flight Vercel function or Cloud Run render mid-call
  (soft-cancel only; late results are discarded by the status guards).
- Event logs for non-pipeline kinds on the runs board (image render events
  stay on the story editor's timeline).
