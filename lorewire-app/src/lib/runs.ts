// Unified read + stop layer for every run kind the admin can watch:
// image renders, voice renders, short renders, hero+thumbnail finishers,
// and refresh-assets chains. Pipeline story jobs keep their richer
// event-streaming read (lib/story-jobs-live); this module covers
// everything the old Live Runs page could NOT see, in one normalized
// shape, plus the guarded soft-cancel writers the Stop controls use.
//
// Cancel discipline mirrors lib/image-render-queue: flip only claimable
// states with a conditional WHERE, so racing a worker claim leaves
// whichever transition lands second as a no-op, and a late worker
// result is discarded by the worker's own status guard.
//
// Plan: _plans/2026-07-03-unified-live-runs-and-stop.md.

import "server-only";

import { all, run } from "@/lib/db";
import {
  cancelAllImageRendersForOwner,
  cancelImageRender,
} from "@/lib/image-render-queue";

export type UnifiedRunKind =
  | "image"
  | "voice"
  | "short"
  | "finisher"
  | "refresh";

export type UnifiedRunStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export interface UnifiedRun {
  kind: UnifiedRunKind;
  /** Underlying row id: image/voice/short render id, story_jobs id for
   *  finishers, story id for refresh chains. */
  id: string;
  storyId: string | null;
  storyTitle: string | null;
  /** Human label: asset slug, voice id, short phase, refresh state. */
  label: string;
  status: UnifiedRunStatus;
  /** 0..100 whole percent where the underlying row reports one. */
  progress: number | null;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

/** Default recent-history window. Matches the pipeline cards' 15-minute
 *  grace so "recently finished" means the same thing across kinds. */
export const DEFAULT_RUNS_WINDOW_MINUTES = 15;
const PER_KIND_CAP = 100;

function normalize(
  status: string | null,
  runningStates: readonly string[],
): UnifiedRunStatus {
  const s = (status ?? "").toLowerCase();
  if (runningStates.includes(s)) return "running";
  if (s === "queued" || s === "pending") return "queued";
  if (s === "done") return "done";
  if (s === "cancelled") return "cancelled";
  return "error";
}

/** Every non-pipeline run that is active OR settled within the window,
 *  newest first. Bounded per kind so the poll stays cheap; kind/status/
 *  search filtering happens client-side on the snapshot. */
export async function listUnifiedRuns(
  windowMinutes: number = DEFAULT_RUNS_WINDOW_MINUTES,
): Promise<UnifiedRun[]> {
  const cutoff = new Date(
    Date.now() - windowMinutes * 60_000,
  ).toISOString();

  const [images, voices, shorts, finishers, refreshes] = await Promise.all([
    all<{
      id: string;
      owner_kind: string;
      owner_id: string;
      asset: string;
      status: string;
      error: string | null;
      requested_at: string;
      started_at: string | null;
      finished_at: string | null;
    }>(
      `SELECT id, owner_kind, owner_id, asset, status, error,
              requested_at, started_at, finished_at
         FROM image_renders
        WHERE status IN ('queued','generating')
           OR (finished_at IS NOT NULL AND finished_at >= ?)
        ORDER BY requested_at DESC LIMIT ${PER_KIND_CAP}`,
      [cutoff],
    ),
    all<{
      id: string;
      story_id: string;
      voice_provider: string | null;
      voice_id: string | null;
      status: string;
      progress: number | null;
      error: string | null;
      requested_at: string;
      started_at: string | null;
      finished_at: string | null;
    }>(
      `SELECT id, story_id, voice_provider, voice_id, status, progress,
              error, requested_at, started_at, finished_at
         FROM voice_renders
        WHERE status IN ('queued','processing')
           OR (finished_at IS NOT NULL AND finished_at >= ?)
        ORDER BY requested_at DESC LIMIT ${PER_KIND_CAP}`,
      [cutoff],
    ),
    all<{
      id: string;
      story_id: string;
      status: string;
      phase: string | null;
      progress: number | null;
      error: string | null;
      requested_at: string;
      started_at: string | null;
      finished_at: string | null;
    }>(
      `SELECT id, story_id, status, phase, progress, error,
              requested_at, started_at, finished_at
         FROM short_renders
        WHERE status IN ('queued','rendering')
           OR (finished_at IS NOT NULL AND finished_at >= ?)
        ORDER BY requested_at DESC LIMIT ${PER_KIND_CAP}`,
      [cutoff],
    ),
    // Finisher runs piggyback on story_jobs rows. There is no dedicated
    // finisher timestamp, so "recently settled" approximates with the
    // job's finished_at — good enough for a 15-minute live window.
    all<{
      id: string;
      story_id: string | null;
      finisher_status: string;
      requested_at: string;
      finished_at: string | null;
    }>(
      `SELECT id, story_id, finisher_status, requested_at, finished_at
         FROM story_jobs
        WHERE finisher_status IN ('pending','running')
           OR (finisher_status IN ('done','failed')
               AND finished_at IS NOT NULL AND finished_at >= ?)
        ORDER BY requested_at DESC LIMIT ${PER_KIND_CAP}`,
      [cutoff],
    ),
    all<{
      id: string;
      refresh_assets_state: string;
      refresh_assets_started_at: string | null;
    }>(
      `SELECT id, refresh_assets_state, refresh_assets_started_at
         FROM stories
        WHERE refresh_assets_state IS NOT NULL
        ORDER BY refresh_assets_started_at DESC LIMIT ${PER_KIND_CAP}`,
    ),
  ]);

  const runs: UnifiedRun[] = [
    ...images.map((r): UnifiedRun => ({
      kind: "image",
      id: r.id,
      storyId: r.owner_kind === "story" ? r.owner_id : null,
      storyTitle: null,
      label:
        r.owner_kind === "story" ? r.asset : `${r.owner_kind}: ${r.asset}`,
      status: normalize(r.status, ["generating"]),
      progress: null,
      requestedAt: r.requested_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      error: r.error,
    })),
    ...voices.map((r): UnifiedRun => ({
      kind: "voice",
      id: r.id,
      storyId: r.story_id,
      storyTitle: null,
      label: r.voice_id
        ? `${r.voice_provider ?? "voice"} · ${r.voice_id}`
        : "voiceover",
      status: normalize(r.status, ["processing"]),
      progress: r.progress,
      requestedAt: r.requested_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      error: r.error,
    })),
    ...shorts.map((r): UnifiedRun => ({
      kind: "short",
      id: r.id,
      storyId: r.story_id,
      storyTitle: null,
      label: r.phase ? `short · ${r.phase}` : "short video",
      status: normalize(r.status, ["rendering"]),
      progress: r.progress,
      requestedAt: r.requested_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      error: r.error,
    })),
    ...finishers.map((r): UnifiedRun => ({
      kind: "finisher",
      id: r.id,
      storyId: r.story_id,
      storyTitle: null,
      label: "hero + thumbnails",
      status: normalize(r.finisher_status, ["running"]),
      progress: null,
      requestedAt: r.requested_at,
      startedAt: null,
      finishedAt: r.finished_at,
      error: null,
    })),
    ...refreshes.map((r): UnifiedRun => ({
      kind: "refresh",
      id: r.id,
      storyId: r.id,
      storyTitle: null,
      label: `refresh · ${r.refresh_assets_state}`,
      status: "running",
      progress: null,
      requestedAt: r.refresh_assets_started_at,
      startedAt: r.refresh_assets_started_at,
      finishedAt: null,
      error: null,
    })),
  ];

  // One batched title lookup so every row is searchable by story title.
  const storyIds = [
    ...new Set(runs.map((r) => r.storyId).filter((v): v is string => !!v)),
  ];
  if (storyIds.length > 0) {
    const titles = await all<{ id: string; title: string | null }>(
      `SELECT id, title FROM stories WHERE id IN (${storyIds
        .map(() => "?")
        .join(", ")})`,
      storyIds,
    );
    const byId = new Map(titles.map((t) => [t.id, t.title]));
    for (const r of runs) {
      if (r.storyId) r.storyTitle = byId.get(r.storyId) ?? null;
    }
  }

  // Active first, then newest requested.
  const rank = (r: UnifiedRun) =>
    r.status === "running" ? 0 : r.status === "queued" ? 1 : 2;
  runs.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.requestedAt ?? "").localeCompare(a.requestedAt ?? ""),
  );
  return runs;
}

// ─── stop ────────────────────────────────────────────────────────────────────

export interface StopRunsCounts {
  images: number;
  voices: number;
  shorts: number;
  jobs: number;
  finishers: number;
  refreshes: number;
}

const EMPTY_COUNTS: StopRunsCounts = {
  images: 0,
  voices: 0,
  shorts: 0,
  jobs: 0,
  finishers: 0,
  refreshes: 0,
};

async function cancelWhere(
  table: string,
  where: string,
  params: unknown[],
  reason: string,
): Promise<number> {
  // Snapshot-then-update (the cancelAllImageRendersForOwner pattern) so
  // the count reflects exactly the rows this call flipped.
  const active = await all<{ id: string }>(
    `SELECT id FROM ${table} WHERE ${where}`,
    params,
  );
  if (active.length === 0) return 0;
  const now = new Date().toISOString();
  await run(
    `UPDATE ${table} SET status = 'cancelled', error = ?, finished_at = ? ` +
      `WHERE id IN (${active.map(() => "?").join(", ")}) AND ${where}`,
    [reason, now, ...active.map((r) => r.id), ...params],
  );
  return active.length;
}

/** Cancel everything in flight for the given stories. Soft-cancel only:
 *  a worker mid-call finishes its current step, then its write no-ops
 *  against the cancelled/cleared status. Spend already incurred is not
 *  refunded. */
export async function stopRunsForStories(
  storyIds: string[],
  reason: string,
): Promise<StopRunsCounts> {
  const counts = { ...EMPTY_COUNTS };
  if (storyIds.length === 0) return counts;
  const marks = storyIds.map(() => "?").join(", ");

  for (const id of storyIds) {
    const { cancelled } = await cancelAllImageRendersForOwner(
      "story",
      id,
      reason,
    );
    counts.images += cancelled.length;
  }

  counts.voices += await cancelWhere(
    "voice_renders",
    `story_id IN (${marks}) AND status IN ('queued','processing')`,
    storyIds,
    reason,
  );
  counts.shorts += await cancelWhere(
    "short_renders",
    `story_id IN (${marks}) AND status IN ('queued','rendering')`,
    storyIds,
    reason,
  );

  // Pipeline story jobs cancel by reddit_id through the existing helper
  // (it also resets the source rows so they can be re-queued cleanly).
  const redditRows = await all<{ reddit_id: string }>(
    `SELECT reddit_id FROM stories
      WHERE id IN (${marks}) AND reddit_id IS NOT NULL`,
    storyIds,
  );
  if (redditRows.length > 0) {
    const { bulkCancelActiveStoryJobs } = await import("@/lib/story-jobs");
    const r = await bulkCancelActiveStoryJobs(
      redditRows.map((x) => x.reddit_id),
    );
    counts.jobs += r.cancelled;
  }

  // Un-arm pending finishers (never claimed, nothing mid-flight). A
  // finisher already 'running' is a live Vercel function and is left to
  // settle on its own.
  const pendingFinishers = await all<{ id: string }>(
    `SELECT id FROM story_jobs
      WHERE story_id IN (${marks}) AND finisher_status = 'pending'`,
    storyIds,
  );
  if (pendingFinishers.length > 0) {
    await run(
      `UPDATE story_jobs SET finisher_status = NULL
        WHERE id IN (${pendingFinishers.map(() => "?").join(", ")})
          AND finisher_status = 'pending'`,
      pendingFinishers.map((r) => r.id),
    );
    counts.finishers += pendingFinishers.length;
  }

  const refreshing = await all<{ id: string }>(
    `SELECT id FROM stories
      WHERE id IN (${marks}) AND refresh_assets_state IS NOT NULL`,
    storyIds,
  );
  if (refreshing.length > 0) {
    await run(
      `UPDATE stories
          SET refresh_assets_state = NULL,
              refresh_assets_started_at = NULL,
              refresh_assets_attempts = 0
        WHERE id IN (${refreshing.map(() => "?").join(", ")})`,
      refreshing.map((r) => r.id),
    );
    counts.refreshes += refreshing.length;
  }

  return counts;
}

/** Stop one unified run. Returns false when the row was already settled
 *  (or, for finishers, already claimed by a live function). */
export async function stopUnifiedRun(
  kind: UnifiedRunKind,
  id: string,
  reason: string,
): Promise<boolean> {
  switch (kind) {
    case "image": {
      const row = await cancelImageRender(id, reason);
      return row?.status === "cancelled";
    }
    case "voice":
      return (
        (await cancelWhere(
          "voice_renders",
          `id = ? AND status IN ('queued','processing')`,
          [id],
          reason,
        )) > 0
      );
    case "short":
      return (
        (await cancelWhere(
          "short_renders",
          `id = ? AND status IN ('queued','rendering')`,
          [id],
          reason,
        )) > 0
      );
    case "finisher": {
      const rows = await all<{ id: string }>(
        `SELECT id FROM story_jobs
          WHERE id = ? AND finisher_status = 'pending'`,
        [id],
      );
      if (rows.length === 0) return false;
      await run(
        `UPDATE story_jobs SET finisher_status = NULL
          WHERE id = ? AND finisher_status = 'pending'`,
        [id],
      );
      return true;
    }
    case "refresh": {
      const rows = await all<{ id: string }>(
        `SELECT id FROM stories
          WHERE id = ? AND refresh_assets_state IS NOT NULL`,
        [id],
      );
      if (rows.length === 0) return false;
      await run(
        `UPDATE stories
            SET refresh_assets_state = NULL,
                refresh_assets_started_at = NULL,
                refresh_assets_attempts = 0
          WHERE id = ?`,
        [id],
      );
      return true;
    }
  }
}
