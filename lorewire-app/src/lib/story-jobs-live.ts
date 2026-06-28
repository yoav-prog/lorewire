// Live runs view data — read-only join over story_jobs + story_job_events +
// reddit_source for the /admin/reddit-sources/live page.
//
// One function: listActiveJobsWithEvents(opts). Returns up to 50 jobs that
// are either in-flight (status queued/processing) or recently finished
// (done/error/cancelled within the 15-minute grace window). For each job
// we attach the latest 50 events so the client can render an inline log
// without a second round trip.
//
// Why server-side join (instead of two endpoints): the live page polls
// every 2 seconds. A single action that returns a snapshot — even when
// there are zero active jobs — is cheaper to reason about than a chain
// of dependent fetches. The 50 / 50 caps make the payload size
// predictable in the worst case.
//
// SQL is portable across the postgres + sqlite drivers: no DISTINCT ON,
// no window functions, no CTEs. Two SELECTs, group in memory.
//
// Types + pure helpers + constants live in ./story-jobs-live-shared.ts
// so the client components can import them without dragging
// "server-only" + the postgres driver into the client bundle. This
// module re-exports the shared surface so existing server callers
// (the page, the actions module, the tests) keep their single import
// site at "@/lib/story-jobs-live".
//
// Plan: _plans/2026-06-28-reddit-sources-live-runs-page.md.

import "server-only";
import { all } from "@/lib/db";
import {
  MAX_ACTIVE_JOBS,
  MAX_EVENTS_PER_JOB,
  FINISHED_GRACE_MS,
  normalizeEventLevel,
  type ActiveJobEvent,
  type ActiveJobView,
  type ListActiveJobsOpts,
} from "@/lib/story-jobs-live-shared";

// Re-export the shared surface so existing imports of
// "@/lib/story-jobs-live" continue to resolve without churn.
export {
  MAX_ACTIVE_JOBS,
  MAX_EVENTS_PER_JOB,
  FINISHED_GRACE_MS,
  ACTIVE_STATUSES,
  FINISHED_STATUSES,
  isJobActive,
  isJobFinished,
  normalizeEventLevel,
} from "@/lib/story-jobs-live-shared";
export type {
  ActiveJobEvent,
  ActiveJobView,
  ListActiveJobsOpts,
} from "@/lib/story-jobs-live-shared";

/**
 * One snapshot read for the live page. Returns active jobs first
 * (queued / processing) then finished-within-grace, both ordered newest
 * requested_at first. Cap at MAX_ACTIVE_JOBS; cap each job's event list
 * at MAX_EVENTS_PER_JOB (most recent N, oldest-first).
 */
export async function listActiveJobsWithEvents(
  opts: ListActiveJobsOpts = {},
): Promise<ActiveJobView[]> {
  const now = opts.now ?? new Date();
  const graceMs = opts.graceMs ?? FINISHED_GRACE_MS;
  const cutoff = new Date(now.getTime() - graceMs).toISOString();

  const jobsRows = await all<{
    job_id: string;
    reddit_id: string;
    status: string;
    progress: number | null;
    error: string | null;
    story_id: string | null;
    requested_at: string;
    started_at: string | null;
    finished_at: string | null;
    title: string | null;
    subreddit: string | null;
  }>(
    `SELECT
       j.id           AS job_id,
       j.reddit_id    AS reddit_id,
       j.status       AS status,
       j.progress     AS progress,
       j.error        AS error,
       j.story_id     AS story_id,
       j.requested_at AS requested_at,
       j.started_at   AS started_at,
       j.finished_at  AS finished_at,
       r.title        AS title,
       r.subreddit    AS subreddit
     FROM story_jobs j
     LEFT JOIN reddit_source r ON r.reddit_id = j.reddit_id
     WHERE j.status IN ('queued', 'processing')
        OR (j.status IN ('done', 'error', 'cancelled')
            AND j.finished_at IS NOT NULL
            AND j.finished_at >= ?)
     ORDER BY j.requested_at DESC
     LIMIT ?`,
    [cutoff, MAX_ACTIVE_JOBS],
  );

  if (jobsRows.length === 0) return [];

  const jobIds = jobsRows.map((r) => r.job_id);
  const placeholders = jobIds.map(() => "?").join(", ");
  const eventsRows = await all<{
    id: string;
    job_id: string;
    ts: string;
    level: string;
    event: string;
    message: string | null;
    payload: string | null;
  }>(
    `SELECT id, job_id, ts, level, event, message, payload
       FROM story_job_events
       WHERE job_id IN (${placeholders})
       ORDER BY ts ASC, id ASC`,
    jobIds,
  );

  // Bucket events per job. The SELECT returned them oldest-first; we
  // keep only the most recent MAX_EVENTS_PER_JOB per job and re-order
  // oldest-first within the bucket so the card renders in chronological
  // order. Trimming after the bucket fill (rather than via LIMIT N
  // per-job in SQL) keeps the query portable across drivers.
  const eventsByJob = new Map<string, ActiveJobEvent[]>();
  for (const e of eventsRows) {
    const bucket = eventsByJob.get(e.job_id) ?? [];
    bucket.push({
      id: e.id,
      ts: e.ts,
      level: normalizeEventLevel(e.level),
      event: e.event,
      message: e.message,
      payload: e.payload,
    });
    eventsByJob.set(e.job_id, bucket);
  }
  for (const [jobId, bucket] of eventsByJob) {
    if (bucket.length > MAX_EVENTS_PER_JOB) {
      eventsByJob.set(jobId, bucket.slice(-MAX_EVENTS_PER_JOB));
    }
  }

  return jobsRows.map((r) => ({
    job_id: r.job_id,
    reddit_id: r.reddit_id,
    status: r.status,
    progress: r.progress,
    error: r.error,
    story_id: r.story_id,
    requested_at: r.requested_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
    title: r.title,
    subreddit: r.subreddit,
    events: eventsByJob.get(r.job_id) ?? [],
  }));
}
