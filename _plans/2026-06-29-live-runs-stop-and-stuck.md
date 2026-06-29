# Live runs: Stop buttons + STUCK flag

Date: 2026-06-29
Branch: feat/phase-3-og-posters
Surface: `/admin/reddit-sources/live`

## Problem

The live runs page showed two cards "RUNNING" for 128h and 190h. Not a
display glitch — the timer was telling the truth. Walking the code:

- The story stage had finished (`story_jobs.status='done'`, the
  "[finished] Done." event), but the SHORT render was a zombie: its
  `short_renders` row was parked in `queued`/`generating`/`rendering` and
  never reached a terminal status.
- A run only leaves the live list when `isPipelineInFlight` goes false
  (`story-jobs-live-shared.ts`). A stuck short keeps it true forever, so
  the card lives on the page and the elapsed chip (counted from
  `story_jobs.requested_at`) climbs without bound.
- Nothing in the system ever times out a stuck stage, and there was no UI
  to clear one. The list-page "Stop" (`bulkCancelActiveStoryJobs`) only
  cancels `queued`/`processing` STORY jobs, so it can't touch a run whose
  article already finished.

Root cause of the zombie itself is operational (the short
generation/render worker or Cloud Run died mid-flight without writing a
terminal status). This work does not retroactively repair that — it gives
the admin a real Stop and surfaces the stuck state.

## Decision (asked + answered)

Scope chosen: **Stop buttons + STUCK badge**. No background reaper/cron —
the admin didn't want an unattended process flipping production pipeline
rows on its own. (Auto-reaper remains a possible later add.)

Stop semantics, decided as defaults:
- A run whose article already finished keeps the article. Only the stuck
  downstream stage is cancelled.
- A run still in the STORY stage cancels the job AND resets its
  `reddit_source` to `imported` (story_id cleared), mirroring the existing
  list-page Stop so it can be re-queued.
- Spend already incurred is not refundable (the confirm dialogs say so).

## What shipped

### Server
- `stopLiveRun(jobId)` in `src/lib/story-jobs.ts`: settles WHATEVER stage
  is in flight —
  - story queued/processing -> cancelled (+ source reset to imported)
  - short queued/generating/rendering -> cancelled. **Force-cancels
    `rendering`**, which `cancelShortRender` deliberately refuses; a row
    stuck in `rendering` for hours is the exact zombie, the renderer is
    gone, there is no clean abort to wait for.
  - hero finisher pending/running -> cancelled
  - auto-publish pending -> cancelled
  - Writes `stopped` events to the story-job timeline + a `cancelled`
    event to the short timeline. Idempotent: a settled run is a no-op
    returning `stopped_stages: []`.
- `stopLiveRunAction(jobId)` + `stopAllActiveLiveRunsAction()` in
  `src/app/admin/actions.ts`. `content.manage`-gated. Stop-all recomputes
  the active set server-side from the same snapshot so it can't be widened
  by a stale client payload.

### Shared pipeline model (`src/lib/story-jobs-live-shared.ts`)
- `short`/`hero`/`publish` cancelled states are now distinct from
  `failed` (a deliberate stop reads "Stopped", not "Failed").
- `computeOverallState`: ANY cancelled stage -> `cancelled` (wins over
  `failed`). Safe because downstream of a real failure settles to
  `skipped`, never `cancelled`; `cancelled` is only ever admin-written.
- `STUCK_THRESHOLD_MS = 2h`, plus pure helpers `jobElapsedMs(view, now)`
  and `isJobStuck(view, now)` shared by the card's elapsed chip and the
  stuck flag so they read the same clock.

### Client
- `LiveJobCard`: per-run **Stop** button (active runs only, wired via an
  `onStop` prop so the SSR unit tests stay action-free), a red **STUCK**
  badge + red elapsed tint once past the threshold, and a single
  ticking-now timer feeding both. Confirm dialog before stopping.
- `LiveRunsClient`: extracted `refresh()` (shared by the poll loop and a
  manual refetch after a stop so the card settles/drops immediately),
  `handleStopRun` / `handleStopAll`, and a **Stop all N** button in the
  status bar (active runs only).

## Behaviour notes
- Stopping a story-stage run shows "Stopped" in the 15-min grace window
  (its `finished_at` is now). Stopping a downstream-stuck run drops it
  from the list on the next refresh (the SQL grace branch keys off the old
  `story_jobs.finished_at`, and the short EXISTS branch no longer matches
  once the short is `cancelled`). Both are acceptable: the run is cleared.

## Tests
- `story-jobs-live-shared.test.ts`: cancelled stage split, cancelled-wins
  overall, `jobElapsedMs` / `isJobStuck` truth table.
- `story-jobs.test.ts`: `stopLiveRun` DB tests (zombie short incl.
  rendering, story-stage reset, hero, publish, settled no-op, missing/empty
  id, timeline event).
- `LiveJobCard.test.tsx` / `LiveRunsClient.test.tsx`: STUCK badge + Stop
  button presence/absence, Stop-all button presence/absence.
- Full affected suite green (128 tests). tsc clean for changed files;
  remaining repo tsc errors are pre-existing in unrelated test files.

## Security
- Both actions re-gate `content.manage` at the data source. Stop-all
  derives its target set server-side (no trust in client-supplied ids).
  Each stage UPDATE is status-guarded so a late worker callback no-ops.

## Rejected
- Auto-reaper cron: more robust but flips prod rows unattended; the admin
  opted out for now.
- Keeping cancelled short -> "Failed": less honest for an admin-initiated
  stop; the model split is small and well covered.
