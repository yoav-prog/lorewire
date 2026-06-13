// Per-editor-session spend tracking + cap for frame regens.
//
// Phase 4 of the video editor overhaul
// (_plans/2026-06-12-video-editor-overhaul.md). The cap is the only
// settings entry the plan kept after the council pass — every other
// toggle was cut as cognitive overload.
//
// A "session" = the window from `_edit_session.started_at` to now,
// scoped to the (story, admin user) pair. Completed regens contribute
// their actual `cost_cents`; in-flight regens contribute the current
// per-image estimate (pending = queued OR generating). Including
// pending in the total keeps the cap honest under double-click bursts
// — daily-budget's pattern of "completed only" can be temporarily
// breached while rows are in flight, and the plan calls this cap
// hard, not soft.
//
// Settings key:
//   video.editor.frame_regen.session_cap_cents — integer, default 500.
//   Server-enforced before every queueFrameImageRegen insert.

import "server-only";

import { one } from "@/lib/db";
import { estimateImageRegenCostCents } from "@/lib/image-render-queue";
import { getSetting } from "@/lib/repo";

export const DEFAULT_FRAME_REGEN_SESSION_CAP_CENTS = 500;
export const FRAME_REGEN_SESSION_CAP_SETTING_KEY =
  "video.editor.frame_regen.session_cap_cents";

export async function getFrameRegenSessionCapCents(): Promise<number> {
  const raw = await getSetting(FRAME_REGEN_SESSION_CAP_SETTING_KEY);
  if (!raw) return DEFAULT_FRAME_REGEN_SESSION_CAP_CENTS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_FRAME_REGEN_SESSION_CAP_CENTS;
  }
  return parsed;
}

export interface SessionSpend {
  /** Sum of cost_cents on completed regens for this session. */
  completedCents: number;
  /** Count of queued/generating regens in this session. */
  pendingCount: number;
  /** Total = completedCents + pendingCount * per-image estimate. */
  totalCents: number;
}

export async function getSessionSpendCents(
  storyId: string,
  userId: string,
  sessionStartedAt: string,
): Promise<SessionSpend> {
  const row = await one<{
    completed: number | string | null;
    pending: number | string | null;
  }>(
    `SELECT
       COALESCE(SUM(cost_cents), 0) AS completed,
       COALESCE(SUM(CASE WHEN status IN ('queued', 'generating') THEN 1 ELSE 0 END), 0) AS pending
     FROM image_renders
     WHERE owner_kind = 'story'
       AND owner_id = ?
       AND asset LIKE 'frame:%'
       AND requested_by = ?
       AND requested_at >= ?`,
    [storyId, userId, sessionStartedAt],
  );
  // Postgres returns SUM as bigint, which the `postgres` driver hands back
  // as a string. Without explicit Number() coercion, downstream `+` and `>`
  // do string operations and the session-cap gate misfires. Same root cause
  // as the daily budget bug fixed in image-render-queue.getDailyImageBudget.
  const completedCents = Number(row?.completed ?? 0) || 0;
  const pendingCount = Number(row?.pending ?? 0) || 0;

  // One DB read for the estimate per call. The asset slug arg is only
  // used by the bulk slugs ("scenes" / "props"); for frame regens the
  // count is always 1 so we pass any frame:* slug.
  const perImage = await estimateImageRegenCostCents("frame:_");
  return {
    completedCents,
    pendingCount,
    totalCents: completedCents + pendingCount * perImage,
  };
}

export interface SessionCapCheck {
  ok: boolean;
  /** Total spent (incl. in-flight estimates) before this new request. */
  spentCents: number;
  /** Hard cap in cents. */
  capCents: number;
  /** Estimate for the new request that's about to be queued. */
  estimateCents: number;
}

export async function canQueueFrameRegenForSession(opts: {
  storyId: string;
  userId: string;
  sessionStartedAt: string;
}): Promise<SessionCapCheck> {
  const [spend, capCents, estimateCents] = await Promise.all([
    getSessionSpendCents(opts.storyId, opts.userId, opts.sessionStartedAt),
    getFrameRegenSessionCapCents(),
    estimateImageRegenCostCents("frame:_"),
  ]);
  return {
    ok: spend.totalCents + estimateCents <= capCents,
    spentCents: spend.totalCents,
    capCents,
    estimateCents,
  };
}
