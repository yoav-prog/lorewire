// Live runs view data — read-only join over story_jobs + story_job_events +
// reddit_source + short_renders for the /admin/reddit-sources/live page.
//
// One function: listActiveJobsWithEvents(opts). Returns up to
// MAX_ACTIVE_JOBS jobs whose pipeline (story stage → short → hero
// thumbnail finisher → optional auto-publish) is still in flight, OR
// whose pipeline settled in the last FINISHED_GRACE_MS window. For
// each job we attach the latest short_renders row + the latest 50
// story_job_events so the client can render the multi-stage state +
// inline log without a second round trip.
//
// Why server-side join (instead of two endpoints): the live page polls
// every 2 seconds. A single action that returns a snapshot — even when
// there are zero active jobs — is cheaper to reason about than a chain
// of dependent fetches. The 50 / 50 caps make the payload size
// predictable in the worst case.
//
// SQL is portable across the postgres + sqlite drivers: no DISTINCT ON,
// no window functions, no CTEs. We over-fetch (broad WHERE clause) and
// apply the precise in-flight / grace logic in TS using the shared
// computePipelineState / isPipelineInFlight / computeLastSettledAt
// helpers so the truth model lives in exactly one place.
//
// Types + pure helpers + constants live in ./story-jobs-live-shared.ts
// so the client components can import them without dragging
// "server-only" + the postgres driver into the client bundle. This
// module re-exports the shared surface so existing server callers
// (the page, the actions module, the tests) keep their single import
// site at "@/lib/story-jobs-live".
//
// Plan: _plans/2026-06-28-live-runs-multistage-pipeline.md.
// Predecessor: _plans/2026-06-28-reddit-sources-live-runs-page.md.

import "server-only";
import { all } from "@/lib/db";
import {
  MAX_ACTIVE_JOBS,
  MAX_EVENTS_PER_JOB,
  FINISHED_GRACE_MS,
  computeLastSettledAt,
  computeOverallState,
  computePipelineState,
  isPipelineInFlight,
  normalizeEventLevel,
  type ActiveJobEvent,
  type ActiveJobShortView,
  type ActiveJobView,
  type ListActiveJobsOpts,
  type PipelineStateInput,
} from "@/lib/story-jobs-live-shared";

// Re-export the shared surface so existing imports of
// "@/lib/story-jobs-live" continue to resolve without churn.
export {
  MAX_ACTIVE_JOBS,
  MAX_EVENTS_PER_JOB,
  FINISHED_GRACE_MS,
  ACTIVE_STATUSES,
  FINISHED_STATUSES,
  computeLastSettledAt,
  computeOverallState,
  computePipelineState,
  isJobActive,
  isJobFinished,
  isPipelineInFlight,
  normalizeEventLevel,
} from "@/lib/story-jobs-live-shared";
export type {
  ActiveJobEvent,
  ActiveJobShortView,
  ActiveJobView,
  ListActiveJobsOpts,
  PipelineOverallState,
  PipelineStage,
  PipelineStageId,
  PipelineStageState,
  PipelineStateInput,
} from "@/lib/story-jobs-live-shared";

/**
 * Over-fetch ceiling for the broad WHERE clause. We pull up to this
 * many candidate rows from SQL and then filter precisely in TS via
 * isPipelineInFlight + last_settled_at < cutoff. Set roughly 4x the
 * client-visible cap so a worst-case batch with lots of recently-
 * settled rows still leaves enough genuinely-active rows visible.
 */
const FETCH_LIMIT = MAX_ACTIVE_JOBS * 4;

interface JobRow {
  job_id: string;
  reddit_id: string;
  status: string;
  progress: number | null;
  error: string | null;
  story_id: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  with_media: number | null;
  full_pipeline: number | null;
  finisher_status: string | null;
  auto_publish_status: string | null;
  title: string | null;
  subreddit: string | null;
  short_id: string | null;
  short_status: string | null;
  short_phase: string | null;
  short_progress: number | null;
  short_error: string | null;
  short_output_url: string | null;
  short_requested_at: string | null;
  short_started_at: string | null;
  short_finished_at: string | null;
}

/**
 * One snapshot read for the live page. Returns active jobs first
 * (any pipeline stage in flight) then finished-within-grace, both
 * ordered newest requested_at first. Cap at MAX_ACTIVE_JOBS; cap each
 * job's event list at MAX_EVENTS_PER_JOB (most recent N, oldest-first).
 */
export async function listActiveJobsWithEvents(
  opts: ListActiveJobsOpts = {},
): Promise<ActiveJobView[]> {
  const now = opts.now ?? new Date();
  const graceMs = opts.graceMs ?? FINISHED_GRACE_MS;
  const cutoff = new Date(now.getTime() - graceMs).toISOString();

  // The WHERE clause is intentionally broad — anything that COULD still
  // be in flight, or finished recently. Precise filtering happens in TS
  // against the computed pipeline state so the truth model lives in
  // exactly one place (computePipelineState / isPipelineInFlight). The
  // short_renders EXISTS branch catches the case where the worker
  // finished (story_jobs.status='done') but the short is still rendering
  // — those rows used to disappear from the previous single-stage view.
  const candidateRows = await all<JobRow>(
    `SELECT
       j.id                   AS job_id,
       j.reddit_id             AS reddit_id,
       j.status                AS status,
       j.progress              AS progress,
       j.error                 AS error,
       j.story_id              AS story_id,
       j.requested_at          AS requested_at,
       j.started_at            AS started_at,
       j.finished_at           AS finished_at,
       j.with_media            AS with_media,
       j.full_pipeline         AS full_pipeline,
       j.finisher_status       AS finisher_status,
       j.auto_publish_status   AS auto_publish_status,
       r.title                 AS title,
       r.subreddit             AS subreddit,
       s.id                    AS short_id,
       s.status                AS short_status,
       s.phase                 AS short_phase,
       s.progress              AS short_progress,
       s.error                 AS short_error,
       s.output_url            AS short_output_url,
       s.requested_at          AS short_requested_at,
       s.started_at            AS short_started_at,
       s.finished_at           AS short_finished_at
     FROM story_jobs j
     LEFT JOIN reddit_source r ON r.reddit_id = j.reddit_id
     LEFT JOIN short_renders s
       ON s.id = (
         SELECT sr.id FROM short_renders sr
          WHERE sr.story_id = j.story_id
          ORDER BY sr.requested_at DESC
          LIMIT 1
       )
     WHERE j.status IN ('queued', 'processing')
        OR (j.status IN ('done', 'error', 'cancelled')
            AND j.finished_at IS NOT NULL
            AND j.finished_at >= ?)
        OR j.finisher_status IN ('pending', 'running')
        OR j.auto_publish_status = 'pending'
        OR EXISTS (
          SELECT 1 FROM short_renders sr2
           WHERE sr2.story_id = j.story_id
             AND sr2.status IN ('queued', 'generating', 'rendering')
        )
     ORDER BY j.requested_at DESC
     LIMIT ?`,
    [cutoff, FETCH_LIMIT],
  );

  if (candidateRows.length === 0) return [];

  // Resolve per-row stage state + decide whether each row is still in
  // flight or settled within the grace window.
  type Resolved = {
    row: JobRow;
    view: Omit<ActiveJobView, "events">;
  };
  const cutoffMs = new Date(cutoff).getTime();
  const resolved: Resolved[] = [];
  for (const row of candidateRows) {
    const short: ActiveJobShortView | null = row.short_id
      ? {
          id: row.short_id,
          status: row.short_status ?? "",
          phase: row.short_phase,
          progress: row.short_progress,
          error: row.short_error,
          output_url: row.short_output_url,
          requested_at: row.short_requested_at ?? "",
          started_at: row.short_started_at,
          finished_at: row.short_finished_at,
        }
      : null;

    const stageInput: PipelineStateInput = {
      story_status: row.status,
      with_media: row.with_media,
      full_pipeline: row.full_pipeline,
      finisher_status: row.finisher_status,
      auto_publish_status: row.auto_publish_status,
      short: short
        ? { status: short.status, phase: short.phase }
        : null,
    };
    const stages = computePipelineState(stageInput);
    const inFlight = isPipelineInFlight(stages);
    const lastSettledAt = computeLastSettledAt({
      stages,
      storyJobFinishedAt: row.finished_at,
      shortFinishedAt: short?.finished_at ?? null,
    });

    // Drop rows that have fully settled outside the grace window. The
    // SQL WHERE was a superset to keep the query simple; this is where
    // the precise pipeline-aware filter applies.
    if (!inFlight) {
      if (lastSettledAt == null || new Date(lastSettledAt).getTime() < cutoffMs) {
        continue;
      }
    }

    const overall = computeOverallState(stages);
    const view: Omit<ActiveJobView, "events"> = {
      job_id: row.job_id,
      reddit_id: row.reddit_id,
      status: row.status,
      progress: row.progress,
      error: row.error,
      story_id: row.story_id,
      requested_at: row.requested_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      title: row.title,
      subreddit: row.subreddit,
      with_media: row.with_media,
      full_pipeline: row.full_pipeline,
      finisher_status: row.finisher_status,
      auto_publish_status: row.auto_publish_status,
      short,
      stages,
      overall,
      last_settled_at: lastSettledAt,
    };
    resolved.push({ row, view });
    if (resolved.length >= MAX_ACTIVE_JOBS) break;
  }

  if (resolved.length === 0) return [];

  // Fetch events only for the rows that survived the precise filter.
  const jobIds = resolved.map((r) => r.row.job_id);
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

  return resolved.map(({ row, view }) => ({
    ...view,
    events: eventsByJob.get(row.job_id) ?? [],
  }));
}
