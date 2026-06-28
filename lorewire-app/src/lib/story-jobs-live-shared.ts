// Client-safe types + pure helpers for the live runs view. This module
// deliberately does NOT import "server-only" or @/lib/db, because the
// LiveRunsClient + LiveJobCard "use client" modules need ActiveJobView
// and the isJobActive / isJobFinished predicates at import time.
// Turbopack pulls every transitive import into the client bundle, so a
// single `import "server-only"` here would drag the postgres driver
// (which references fs/net/tls/perf_hooks) into the browser and fail
// the build — exactly what tripped the first preview deploy on
// 2026-06-28.
//
// The server-only DB function listActiveJobsWithEvents lives in
// ./story-jobs-live.ts, which re-exports everything below so existing
// server callers keep their single import site.

export const MAX_ACTIVE_JOBS = 50;
export const MAX_EVENTS_PER_JOB = 50;
export const FINISHED_GRACE_MS = 15 * 60 * 1000;

export const ACTIVE_STATUSES = ["queued", "processing"] as const;
export const FINISHED_STATUSES = ["done", "error", "cancelled"] as const;

export interface ActiveJobEvent {
  id: string;
  ts: string;
  level: "info" | "warn" | "error";
  event: string;
  message: string | null;
  /** JSON-encoded structured payload. Client parses + displays inline. */
  payload: string | null;
}

export interface ActiveJobView {
  job_id: string;
  reddit_id: string;
  /** Job status as written by the worker / cancel path. May include
   *  'cancelled' even though StoryJobStatus in story-jobs.ts narrows
   *  finished states to done/error — we surface the raw column so the
   *  card can render a 'Stopped' chip honestly. */
  status: string;
  progress: number | null;
  error: string | null;
  story_id: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** From reddit_source. NULL when the source row was deleted between
   *  enqueue and now (defensive; should not happen). */
  title: string | null;
  subreddit: string | null;
  /** Latest MAX_EVENTS_PER_JOB events, oldest-first. */
  events: ActiveJobEvent[];
}

export interface ListActiveJobsOpts {
  /** Override the wall clock for deterministic tests. */
  now?: Date;
  /** Override the grace window for tests. */
  graceMs?: number;
}

/**
 * Returns true if a job row is currently in-flight (vs. finished-grace).
 * Exposed so the client can colour active vs. settled cards consistently
 * with the same predicate the SQL uses.
 */
export function isJobActive(view: ActiveJobView): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(view.status);
}

/**
 * Returns true if a job is settled (done/error/cancelled). Mirrors the
 * SQL's finished branch; used for the `?finished=hide` URL param.
 */
export function isJobFinished(view: ActiveJobView): boolean {
  return (FINISHED_STATUSES as readonly string[]).includes(view.status);
}

/**
 * Normalises the raw `level` column from story_job_events to the
 * documented enum. Anything unrecognised falls back to 'info' so the
 * client never has to defend against unknown levels — the worker
 * could decide to write 'debug' tomorrow and the UI wouldn't crash.
 *
 * Exported because listActiveJobsWithEvents applies it on the server
 * before handing rows to the client.
 */
export function normalizeEventLevel(raw: string): "info" | "warn" | "error" {
  if (raw === "warn" || raw === "error") return raw;
  return "info";
}
