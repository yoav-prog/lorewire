// TS read/write helpers for the story_jobs queue.
//
// The Python worker (pipeline/story_jobs_worker.py) is the only consumer
// of the queue; this module only ever writes status='queued' rows (the
// admin "Process N selected" path) and reads the rest for the admin UI.

import "server-only";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";

export type StoryJobStatus = "queued" | "processing" | "done" | "error";

export interface StoryJobRow {
  id: string;
  reddit_id: string;
  status: StoryJobStatus;
  progress: number | null;
  error: string | null;
  story_id: string | null;
  with_media: number | null;
  requested_by: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const COLS =
  "id, reddit_id, status, progress, error, story_id, with_media, requested_by, requested_at, started_at, finished_at";

export interface BulkEnqueueResult {
  enqueued: number;
  skipped_active: number;     // already had a queued/processing job
  skipped_status: number;     // reddit_source not in 'imported' (or any allowed) status
  not_found: number;          // reddit_id didn't match any row
  enqueued_ids: string[];     // reddit_ids that actually got a job inserted
}

// Reddit source statuses that may be promoted into the pipeline. 'imported'
// is the natural case; 'queued' too (an admin re-clicks after a worker
// crashed and reset the row). 'used' and 'skipped' are deliberately
// excluded — re-processing a used row is a separate explicit affordance,
// and skipped is the user's "no" answer.
const ALLOWED_SOURCE_STATUSES: ReadonlySet<string> = new Set([
  "imported",
  "queued",
]);

export async function bulkEnqueueStoryJobs(
  redditIds: string[],
  opts: { with_media?: boolean; requested_by?: string | null } = {},
): Promise<BulkEnqueueResult> {
  const result: BulkEnqueueResult = {
    enqueued: 0,
    skipped_active: 0,
    skipped_status: 0,
    not_found: 0,
    enqueued_ids: [],
  };
  if (redditIds.length === 0) return result;

  const withMedia = opts.with_media === false ? 0 : 1;
  const requestedBy = opts.requested_by ?? null;
  const now = new Date().toISOString();

  // One snapshot read for the candidate rows + one for in-flight jobs, both
  // chunked to stay under the 999/32767 bind ceilings. Per-row checks then
  // run in memory; the writes are also chunked into a single multi-row
  // INSERT for the queue + one bulk UPDATE for the reddit_source state.

  const sourceRows = await snapshotSourceStatuses(redditIds);
  const activeReddit = await snapshotActiveJobs(redditIds);

  const toInsert: StoryJobRow[] = [];
  const toFlipQueued: string[] = [];

  for (const rid of redditIds) {
    const status = sourceRows.get(rid);
    if (status === undefined) {
      result.not_found++;
      continue;
    }
    if (!ALLOWED_SOURCE_STATUSES.has(status)) {
      result.skipped_status++;
      continue;
    }
    if (activeReddit.has(rid)) {
      result.skipped_active++;
      continue;
    }
    toInsert.push({
      id: randomUUID(),
      reddit_id: rid,
      status: "queued",
      progress: 0,
      error: null,
      story_id: null,
      with_media: withMedia,
      requested_by: requestedBy,
      requested_at: now,
      started_at: null,
      finished_at: null,
    });
    // Only flip reddit_source.status when the row was 'imported'; a row
    // already 'queued' (from a previous attempt the worker reset) stays as
    // it is — no spurious UPDATE.
    if (status === "imported") toFlipQueued.push(rid);
  }

  if (toInsert.length > 0) {
    await bulkInsertJobs(toInsert);
    // Race-loss handling: bulkInsertJobs uses ON CONFLICT DO NOTHING
    // against the partial unique index, so a concurrent enqueue can
    // silently make one of our INSERTs no-op. Re-query story_jobs by id
    // to learn which rows actually landed. Only flip the source rows
    // whose INSERT genuinely succeeded — flipping a race-loser's source
    // to 'queued' would leave it stranded (UI hides it from 'imported',
    // no worker can claim it because no active job exists).
    const insertedIds = await readBackInsertedJobIds(
      toInsert.map((r) => r.id),
    );
    const insertedRedditIds = new Set<string>();
    for (const r of toInsert) {
      if (insertedIds.has(r.id)) insertedRedditIds.add(r.reddit_id);
    }
    result.enqueued = insertedRedditIds.size;
    result.enqueued_ids = toInsert
      .filter((r) => insertedRedditIds.has(r.reddit_id))
      .map((r) => r.reddit_id);
    // Anything in toInsert that DIDN'T land is a race-loser — bump
    // skipped_active so the admin sees what happened.
    result.skipped_active += toInsert.length - insertedRedditIds.size;
    // Trim toFlipQueued to only the survivors.
    const survivors = toFlipQueued.filter((rid) => insertedRedditIds.has(rid));
    if (survivors.length > 0) {
      await bulkFlipSourceStatus(survivors, "queued");
    }
  }

  return result;
}

// Returns the subset of `jobIds` that actually exist in story_jobs. Used
// by bulkEnqueueStoryJobs to detect which INSERTs survived an ON CONFLICT
// DO NOTHING under concurrent enqueueing.
async function readBackInsertedJobIds(jobIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (jobIds.length === 0) return out;
  for (let i = 0; i < jobIds.length; i += 500) {
    const batch = jobIds.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(", ");
    const rows = await all<{ id: string }>(
      `SELECT id FROM story_jobs WHERE id IN (${placeholders})`,
      batch,
    );
    for (const r of rows) out.add(r.id);
  }
  return out;
}

async function snapshotSourceStatuses(
  redditIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < redditIds.length; i += 500) {
    const batch = redditIds.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(", ");
    const rows = await all<{ reddit_id: string; status: string }>(
      `SELECT reddit_id, status FROM reddit_source WHERE reddit_id IN (${placeholders})`,
      batch,
    );
    for (const r of rows) out.set(r.reddit_id, r.status);
  }
  return out;
}

async function snapshotActiveJobs(
  redditIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < redditIds.length; i += 500) {
    const batch = redditIds.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(", ");
    const rows = await all<{ reddit_id: string }>(
      `SELECT DISTINCT reddit_id FROM story_jobs ` +
        `WHERE status IN ('queued', 'processing') ` +
        `AND reddit_id IN (${placeholders})`,
      batch,
    );
    for (const r of rows) out.add(r.reddit_id);
  }
  return out;
}

const INSERT_COLS = [
  "id",
  "reddit_id",
  "status",
  "progress",
  "error",
  "story_id",
  "with_media",
  "requested_by",
  "requested_at",
  "started_at",
  "finished_at",
] as const;

async function bulkInsertJobs(rows: StoryJobRow[]): Promise<void> {
  const cols = INSERT_COLS.join(", ");
  const chunkSize = 500;
  // ON CONFLICT clause matches the partial unique index
  // `idx_story_jobs_one_active` exactly (same predicate on `status`).
  // Without this, a race-loser INSERT in a multi-row batch would throw
  // UNIQUE and abort the whole batch — even the rows that would have
  // been fine. With DO NOTHING the race-losers silently skip.
  const conflictClause =
    "ON CONFLICT (reddit_id) WHERE status IN ('queued', 'processing') DO NOTHING";
  for (let i = 0; i < rows.length; i += chunkSize) {
    const batch = rows.slice(i, i + chunkSize);
    const placeholders = batch
      .map(() => `(${INSERT_COLS.map(() => "?").join(", ")})`)
      .join(", ");
    const params: unknown[] = [];
    for (const r of batch) {
      for (const c of INSERT_COLS) {
        params.push((r as unknown as Record<string, unknown>)[c] ?? null);
      }
    }
    await run(
      `INSERT INTO story_jobs (${cols}) VALUES ${placeholders} ${conflictClause}`,
      params,
    );
  }
}

async function bulkFlipSourceStatus(
  redditIds: string[],
  status: string,
): Promise<void> {
  // Conditional on `status = 'imported'` so a row already promoted to
  // 'processing' by a worker between our snapshot and this UPDATE isn't
  // demoted back to 'queued'. The caller (bulkEnqueueStoryJobs) only
  // ever flips imported -> queued, so this guard never blocks a
  // legitimate flip; it only prevents the race-window regression.
  for (let i = 0; i < redditIds.length; i += 500) {
    const batch = redditIds.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(", ");
    await run(
      `UPDATE reddit_source SET status = ? ` +
        `WHERE status = 'imported' AND reddit_id IN (${placeholders})`,
      [status, ...batch],
    );
  }
}

// ---------- reads for the admin UI ----------

export async function getLatestStoryJobForReddit(
  redditId: string,
): Promise<StoryJobRow | null> {
  if (!redditId) return null;
  return one<StoryJobRow>(
    `SELECT ${COLS} FROM story_jobs WHERE reddit_id = ? ORDER BY requested_at DESC LIMIT 1`,
    [redditId],
  );
}

export async function listLatestStoryJobsForReddit(
  redditIds: string[],
): Promise<Map<string, StoryJobRow>> {
  // "latest per reddit_id" — pulled in chunks. We grab every job for the
  // batch and reduce in memory, which keeps the SQL portable across the
  // two drivers (no DISTINCT ON / window function).
  const out = new Map<string, StoryJobRow>();
  if (redditIds.length === 0) return out;
  for (let i = 0; i < redditIds.length; i += 500) {
    const batch = redditIds.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(", ");
    const rows = await all<StoryJobRow>(
      `SELECT ${COLS} FROM story_jobs ` +
        `WHERE reddit_id IN (${placeholders}) ` +
        `ORDER BY requested_at DESC`,
      batch,
    );
    for (const r of rows) {
      if (!out.has(r.reddit_id)) out.set(r.reddit_id, r);
    }
  }
  return out;
}

export async function countPendingStoryJobs(): Promise<number> {
  const row = await one<{ n: number | string }>(
    `SELECT count(*) AS n FROM story_jobs WHERE status IN ('queued', 'processing')`,
    [],
  );
  return Number(row?.n ?? 0);
}
