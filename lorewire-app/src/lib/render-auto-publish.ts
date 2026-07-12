// Render Scheduler auto-publish lane (2026-07-12).
//
// The Render Scheduler drip renders Reddit sources and leaves every story in
// `review` for a human to approve. This lane, when the owner opts in
// (render.auto_publish), publishes those stories automatically once they are
// asset-complete and pass the safety judge — the exact same per-story step
// autopilot uses (approveReviewedStory), pointed at render-scheduler rows.
//
// Scope is strict: only stories whose story_job was enqueued by the drip
// (requested_by = 'render-scheduler') are eligible, so a story a human made
// or is holding in review is never touched. Independent of autopilot: this
// lane has its OWN on/off switch and its OWN circuit breaker, so a systemic
// failure here disables auto-publish here without touching autopilot.
//
// Plan: _plans/2026-07-12-render-scheduler-auto-publish.md.

import "server-only";

import { all } from "@/lib/db";
import { getSetting, setSetting } from "@/lib/repo";
import {
  RENDER_SCHEDULER_REQUESTED_BY,
  RENDER_SETTING_KEYS,
  getRenderAutoPublish,
} from "@/lib/render-scheduler";
import {
  approveReviewedStory,
  type ApproveBreaker,
  type ApproveCandidate,
} from "@/lib/approve-reviewed-story";
import { AUTOPILOT_DEFAULTS, getAutopilotAlertEmail } from "@/lib/autopilot";
import { sendBrevoEmail } from "@/lib/email";

// ---- settings keys -----------------------------------------------------

export const RENDER_AUTOPUBLISH_SETTING_KEYS = {
  /** Internal: consecutive publish EXCEPTIONS. The breaker trips at the
   *  threshold and flips render.auto_publish off. */
  consecutiveFailures: "render.auto_publish_consecutive_failures",
  /** Internal: ISO timestamp of the last breaker trip, for the UI banner. */
  trippedAt: "render.auto_publish_tripped_at",
} as const;

// Stories one tick handles. Publishing schedules four platforms of work per
// story; keep the batch small and let the 2-minute cadence carry the volume.
const AUTOPUBLISH_BATCH_LIMIT = 3;

// ---- candidate selection ----------------------------------------------

// Rendered render-scheduler stories waiting in review, oldest first,
// excluding anything already held for a human (a held story belongs to the
// human now, exactly as in the autopilot lane).
async function selectAutoPublishCandidates(): Promise<ApproveCandidate[]> {
  return all<ApproveCandidate>(
    `SELECT s.id, s.reddit_id, s.title, s.body FROM stories s
     WHERE s.status = 'review'
       AND s.id IN (
         SELECT story_id FROM story_jobs
         WHERE requested_by = ? AND story_id IS NOT NULL
       )
       AND s.id NOT IN (
         SELECT story_id FROM scheduler_decisions WHERE decision = 'auto_held'
       )
     ORDER BY s.updated_at ASC
     LIMIT ${AUTOPUBLISH_BATCH_LIMIT}`,
    [RENDER_SCHEDULER_REQUESTED_BY],
  );
}

// ---- circuit breaker ---------------------------------------------------

async function getConsecutiveFailures(): Promise<number> {
  const raw = await getSetting(RENDER_AUTOPUBLISH_SETTING_KEYS.consecutiveFailures);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Reset the render-lane failure counter. Called on a clean publish and when
 *  an admin re-enables the toggle after a trip. */
export async function resetRenderAutoPublishFailures(): Promise<void> {
  await setSetting(RENDER_AUTOPUBLISH_SETTING_KEYS.consecutiveFailures, "0");
}

/** Count one publish EXCEPTION; at the threshold, flip render.auto_publish
 *  off, stamp the trip time, and alert the owner. Returns whether this
 *  failure tripped the breaker. Mirrors autopilot's breaker but scoped to
 *  the render lane's own switch. */
async function recordRenderAutoPublishFailure(
  storyId: string,
  reason: string,
  nowMs: number,
): Promise<boolean> {
  const failures = (await getConsecutiveFailures()) + 1;
  await setSetting(
    RENDER_AUTOPUBLISH_SETTING_KEYS.consecutiveFailures,
    String(failures),
  );
  if (failures < AUTOPILOT_DEFAULTS.breakerThreshold) return false;

  await setSetting(RENDER_SETTING_KEYS.autoPublish, "0");
  await setSetting(
    RENDER_AUTOPUBLISH_SETTING_KEYS.trippedAt,
    new Date(nowMs).toISOString(),
  );
  console.error("[render-autopublish breaker] tripped — auto-publish disabled", {
    failures,
    last_story_id: storyId,
    last_reason: reason.slice(0, 200),
  });

  const alertEmail = await getAutopilotAlertEmail();
  if (alertEmail) {
    const text =
      `Lorewire render-scheduler auto-publish switched itself off after ${failures} consecutive publish failures.\n\n` +
      `Last story: ${storyId}\nLast error: ${reason.slice(0, 300)}\n\n` +
      `Scheduler-rendered stories will wait in review for a human until you turn auto-publish back on at /admin/scheduler.`;
    const sent = await sendBrevoEmail({
      to: alertEmail,
      subject: "Lorewire render auto-publish disabled itself",
      html: `<p>${text.replace(/\n/g, "<br/>")}</p>`,
      text,
    });
    console.info("[render-autopublish breaker] alert email", {
      to: alertEmail,
      ok: sent.ok,
      error: sent.error ?? null,
    });
  }
  return true;
}

// ---- the tick ----------------------------------------------------------

export type RenderAutoPublishReason = "ok" | "disabled" | "no_candidates";

export interface RenderAutoPublishResult {
  reason: RenderAutoPublishReason;
  approved: number;
  held: number;
  /** Stories whose publish gate refused but that stay candidates for the
   *  next tick (asset backfill may still land). Held after the
   *  gateRefusalHoldAfter threshold. */
  deferred: number;
  failed: number;
  skipped: number;
  /** True when this tick tripped the circuit breaker (auto-publish now off). */
  tripped: boolean;
}

const EMPTY = {
  approved: 0,
  held: 0,
  deferred: 0,
  failed: 0,
  skipped: 0,
  tripped: false,
} as const;

/**
 * One auto-publish tick. Off unless render.auto_publish is on. Screens each
 * ready render-scheduler story and pushes clean ones through the shared
 * approve path (same gate + scheduler a human Approve uses). Idempotent under
 * overlapping crons: an already-published story reports skipped, and
 * scheduleStoryPublish dedupes per (story, platform).
 */
export async function runRenderSchedulerAutoPublish(
  nowMs: number = Date.now(),
): Promise<RenderAutoPublishResult> {
  const enabled = await getRenderAutoPublish();
  if (!enabled) return { reason: "disabled", ...EMPTY };

  const candidates = await selectAutoPublishCandidates();
  if (candidates.length === 0) return { reason: "no_candidates", ...EMPTY };

  const breaker: ApproveBreaker = {
    recordFailure: (storyId, reason, ms) =>
      recordRenderAutoPublishFailure(storyId, reason, ms),
    resetFailures: resetRenderAutoPublishFailures,
  };

  let approved = 0;
  let held = 0;
  let deferred = 0;
  let failed = 0;
  let skipped = 0;
  let tripped = false;

  for (const story of candidates) {
    const result = await approveReviewedStory(story, {
      decidedBy: RENDER_SCHEDULER_REQUESTED_BY,
      gateRefusalHoldAfter: AUTOPILOT_DEFAULTS.gateRefusalHoldAfter,
      breaker,
      logLabel: "render-autopublish",
      nowMs,
    });
    switch (result.outcome) {
      case "approved":
        approved += 1;
        break;
      case "held":
        held += 1;
        break;
      case "deferred":
        deferred += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
      case "failed":
        failed += 1;
        break;
    }
    if (result.tripped) {
      tripped = true;
      break; // breaker fired: stop the batch immediately
    }
  }

  return { reason: "ok", approved, held, deferred, failed, skipped, tripped };
}

/** Trip-state for the admin banner: whether the lane breaker fired and when. */
export interface RenderAutoPublishStatus {
  enabled: boolean;
  trippedAt: string | null;
  consecutiveFailures: number;
}

export async function getRenderAutoPublishStatus(): Promise<RenderAutoPublishStatus> {
  const [enabled, trippedAt, failures] = await Promise.all([
    getRenderAutoPublish(),
    getSetting(RENDER_AUTOPUBLISH_SETTING_KEYS.trippedAt),
    getConsecutiveFailures(),
  ]);
  return {
    enabled,
    trippedAt: trippedAt?.trim() || null,
    consecutiveFailures: failures,
  };
}
