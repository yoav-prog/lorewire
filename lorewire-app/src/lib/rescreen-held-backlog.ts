// Re-screen the held backlog with the CURRENT safety judge.
//
// Context: the legacy judge (gpt-5-nano + a 0.7 confidence gate) held ~98% of
// an ordinary AITA-style feed. When the recalibrated v2 judge is switched on
// (safety_judge.mode = active), it fixes new stories going forward — but the
// stories the old judge already held stay held, because a hold is final for the
// unattended lanes and waits for a human. This backlog can be hundreds of
// stories, far too many to clear one "Publish anyway" click at a time.
//
// This module drains that backlog: it re-runs each held story through the exact
// same shared approve step the live lanes use (approveReviewedStory), so the
// CURRENT judge decides again. Stories it now clears publish; stories it still
// holds get a fresh verdict (so the "held & why" list shows the new reason) and
// are marked so a later batch skips them. Purely a human-initiated catch-up —
// it never runs on a cron.
//
// Reuses approveReviewedStory (rule 20: the publish gate, scheduling, decision
// logging, and the emergency-stop guard all live there, in one place). A no-op
// breaker keeps this manual pass from ever tripping a live lane's circuit
// breaker. Bounded per call so a large backlog cannot outrun the function
// timeout; the caller loops by clicking again while `remaining` is non-zero.

import "server-only";

import { all, one } from "@/lib/db";
import {
  approveReviewedStory,
  type ApproveBreaker,
  type ApproveCandidate,
} from "@/lib/approve-reviewed-story";
import { AUTOPILOT_DEFAULTS } from "@/lib/autopilot";

/** Stamped on scheduler_decisions.decided_by for every row this pass writes.
 *  Doubles as the "already re-screened" marker: a story that stays held gets an
 *  auto_held row by this actor, and the candidate query excludes anything this
 *  actor has already touched, so repeated batches drain instead of looping on
 *  the same still-held stories. Distinct from the lane actors ("autopilot",
 *  "render-scheduler") so re-screen decisions are attributable. */
export const RESCREEN_DECIDED_BY = "rescreen-backlog";

/** Log namespace for this lane's lines (rule 14). */
export const RESCREEN_LOG_LABEL = "rescreen";

/** Stories re-screened per invocation. One judge call (and possibly a publish)
 *  each; at ~3-4s apiece this stays well inside the 300s function budget while
 *  giving the admin visible, resumable progress. */
export const RESCREEN_DEFAULT_LIMIT = 25;

// A hold is final for the live lanes, so a held story never reaches their
// breaker — but this pass calls the same step directly, and a manual catch-up
// must not be able to disable a live lane. A no-op breaker records nothing and
// resets nothing.
const NOOP_BREAKER: ApproveBreaker = {
  recordFailure: async () => false,
  resetFailures: async () => {},
};

// The held backlog not yet touched by a re-screen: still in review, held by an
// unattended lane at least once, and never processed by this pass. Shared by
// the candidate select and the remaining count so both agree on what "left"
// means. Portable across the SQLite/Postgres pair (plain IN/NOT IN subqueries,
// no bare-column GROUP BY).
const HELD_BACKLOG_WHERE = `s.status = 'review'
    AND s.id IN (SELECT story_id FROM scheduler_decisions WHERE decision = 'auto_held')
    AND s.id NOT IN (SELECT story_id FROM scheduler_decisions WHERE decided_by = ?)`;

async function selectRescreenCandidates(limit: number): Promise<ApproveCandidate[]> {
  return all<ApproveCandidate>(
    `SELECT s.id, s.reddit_id, s.title, s.body FROM stories s
      WHERE ${HELD_BACKLOG_WHERE}
      ORDER BY s.updated_at ASC
      LIMIT ?`,
    [RESCREEN_DECIDED_BY, limit],
  );
}

/** How many held stories still await a re-screen. Drives the button's "N left"
 *  label and its done state. */
export async function countRescreenBacklog(): Promise<number> {
  const row = await one<{ n: number | string }>(
    `SELECT count(*) AS n FROM stories s WHERE ${HELD_BACKLOG_WHERE}`,
    [RESCREEN_DECIDED_BY],
  );
  return Number(row?.n ?? 0);
}

export interface RescreenBacklogResult {
  /** Stories run through the judge this batch. */
  processed: number;
  /** Now cleared and published (live on the site, social queued). */
  published: number;
  /** Still held by the current judge (fresh verdict recorded). */
  stillHeld: number;
  /** Cleared the judge but the publish gate refused (assets not ready yet);
   *  left in review for the normal lanes to finish. */
  deferred: number;
  /** Threw during publish (counted, not tripped — the breaker is a no-op). */
  failed: number;
  /** Emergency stop engaged mid-batch; nothing published. Normally 0 because
   *  the caller pre-checks the stop. */
  skipped: number;
  /** Held stories still awaiting a re-screen after this batch. */
  remaining: number;
}

/**
 * Re-screen up to `limit` held stories with the current safety judge, publishing
 * the ones it now clears. Idempotent and resumable: each still-held story is
 * marked (auto_held by RESCREEN_DECIDED_BY) and excluded from later batches, and
 * published stories leave review, so calling this repeatedly drains the backlog
 * to zero without re-touching the same rows.
 */
export async function rescreenHeldBacklog(
  opts: { limit?: number; nowMs?: number } = {},
): Promise<RescreenBacklogResult> {
  const limit =
    opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : RESCREEN_DEFAULT_LIMIT;
  const nowMs = opts.nowMs ?? Date.now();

  const candidates = await selectRescreenCandidates(limit);
  let published = 0;
  let stillHeld = 0;
  let deferred = 0;
  let failed = 0;
  let skipped = 0;

  for (const story of candidates) {
    const result = await approveReviewedStory(story, {
      decidedBy: RESCREEN_DECIDED_BY,
      gateRefusalHoldAfter: AUTOPILOT_DEFAULTS.gateRefusalHoldAfter,
      breaker: NOOP_BREAKER,
      logLabel: RESCREEN_LOG_LABEL,
      nowMs,
    });
    switch (result.outcome) {
      case "approved":
        published++;
        break;
      case "held":
        stillHeld++;
        break;
      case "deferred":
        deferred++;
        break;
      case "failed":
        failed++;
        break;
      case "skipped":
        skipped++;
        break;
    }
  }

  const remaining = await countRescreenBacklog();
  console.info("[rescreen backlog] batch done", {
    processed: candidates.length,
    published,
    stillHeld,
    deferred,
    failed,
    skipped,
    remaining,
  });

  return { processed: candidates.length, published, stillHeld, deferred, failed, skipped, remaining };
}
