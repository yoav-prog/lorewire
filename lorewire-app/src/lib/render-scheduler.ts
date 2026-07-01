// Render Scheduler: the cost governor for automatic Reddit-source rendering.
//
// This module decides WHETHER to auto-enqueue more renders right now
// (the backpressure gate, below) and, when it may, HOW MANY and WHICH
// sources (the drip + selection, added in Phase 2). It never renders
// anything itself; it only feeds the existing story_jobs queue via
// bulkEnqueueStoryJobs, which the Python worker drains.
//
// The load-bearing idea is backpressure. A steady drip that keeps
// rendering regardless of whether a human ever approves anything turns
// the review queue into an unbounded buffer: renders pile up stale and
// the budget burns while nobody is looking. So before enqueuing, the
// gate checks that a human can still keep up (review-queue depth is not
// past its cap, and the oldest waiting story is not older than the
// stale window) and that today's budget is not already spent. If any
// gate trips, the scheduler pauses and says why.
//
// Plan: _plans/2026-07-01-render-and-publish-schedulers.md.

import "server-only";

import { all, one, run } from "@/lib/db";
import { getSetting, setSetting } from "@/lib/repo";
import { getBudgetSummary } from "@/lib/story-jobs-budget";
import { bulkEnqueueStoryJobs, countPendingStoryJobs } from "@/lib/story-jobs";
import type { RedditSourceStrength } from "@/lib/reddit-source";

// ---- settings keys + defaults ----------------------------------------

export const RENDER_SETTING_KEYS = {
  /** Master on/off. Defaults OFF so the scheduler never runs until an
   *  admin opts in. */
  enabled: "render.enabled",
  /** Renders to enqueue per hour when the gate is open. Fractional is
   *  fine (0.5 = 12/day). Used by the Phase 2 drip. */
  ratePerHour: "render.rate_per_hour",
  /** Pause when this many stories sit in `review`. The human has fallen
   *  behind; stop making more work. */
  reviewQueueCap: "render.review_queue_cap",
  /** Pause when the oldest waiting `review` story is at least this many
   *  hours old. Catches "human went on vacation" without needing a
   *  separate activity feed. */
  staleHours: "render.stale_hours",
  /** Minimum source strength eligible for auto-render: "none" (all),
   *  "medium", or "strong". Weaker sources are left for manual Process N. */
  eligibilityMinStrength: "render.eligibility_min_strength",
  /** Auto-archive a scheduler-created story that has sat in `review` this
   *  many days without approval. Keeps stale Reddit-derived shorts from
   *  rotting in the queue. Raise it high to effectively disable GC. */
  freshnessTtlDays: "render.freshness_ttl_days",
  /** Internal drip cursor: ISO timestamp of the last credited enqueue.
   *  Not admin-facing; the token bucket advances it. */
  lastEnqueueAt: "render.last_enqueue_at",
} as const;

export const RENDER_DEFAULTS = {
  ratePerHour: 0.5, // 12 renders/day
  reviewQueueCap: 20,
  staleHours: 48,
  freshnessTtlDays: 7,
} as const;

// Stamped on story_jobs.requested_by for every row the drip enqueues, so
// the stale-review GC can target scheduler-created stories only and never
// archive a review item a human made by hand.
export const RENDER_SCHEDULER_REQUESTED_BY = "render-scheduler";

// ---- setting readers -------------------------------------------------

/** True only when the setting is explicitly "1" / "true". Defaults OFF:
 *  a missing or malformed value must never auto-start the scheduler. */
export async function getRenderEnabled(): Promise<boolean> {
  const raw = (await getSetting(RENDER_SETTING_KEYS.enabled))?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

// Parse a stored positive number, falling back to `fallback` for blank,
// non-numeric, or non-positive values. A corrupt setting must land on a
// safe default, never on 0 or NaN that could jam or unbound the gate.
function positiveNumberSetting(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export async function getRenderRatePerHour(): Promise<number> {
  return positiveNumberSetting(
    await getSetting(RENDER_SETTING_KEYS.ratePerHour),
    RENDER_DEFAULTS.ratePerHour,
  );
}

export async function getReviewQueueCap(): Promise<number> {
  return positiveNumberSetting(
    await getSetting(RENDER_SETTING_KEYS.reviewQueueCap),
    RENDER_DEFAULTS.reviewQueueCap,
  );
}

export async function getStaleHours(): Promise<number> {
  return positiveNumberSetting(
    await getSetting(RENDER_SETTING_KEYS.staleHours),
    RENDER_DEFAULTS.staleHours,
  );
}

export async function getFreshnessTtlDays(): Promise<number> {
  return positiveNumberSetting(
    await getSetting(RENDER_SETTING_KEYS.freshnessTtlDays),
    RENDER_DEFAULTS.freshnessTtlDays,
  );
}

// ---- review-queue reads ----------------------------------------------

/** How many stories are waiting in `review` right now. This is the
 *  depth the backpressure gate compares against the cap. */
export async function countStoriesInReview(): Promise<number> {
  const row = await one<{ n: number | string }>(
    "SELECT count(*) AS n FROM stories WHERE status = 'review'",
    [],
  );
  return Number(row?.n ?? 0);
}

/**
 * Age in hours of the oldest story sitting in `review`, or null when the
 * review queue is empty. "Oldest" is measured on updated_at because that
 * is the timestamp both the pipeline and the admin touch when a story
 * changes; a story an admin is actively working stays fresh, one nobody
 * has touched drifts older. Good enough to answer "has the human gone
 * quiet while work waits" without a dedicated review-entry column.
 */
export async function getOldestReviewAgeHours(
  nowMs: number = Date.now(),
): Promise<number | null> {
  const row = await one<{ m: string | null }>(
    "SELECT MIN(updated_at) AS m FROM stories WHERE status = 'review'",
    [],
  );
  const oldest = row?.m;
  if (!oldest) return null;
  const then = Date.parse(oldest);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, (nowMs - then) / 3_600_000);
}

// ---- the gate --------------------------------------------------------

export type RenderGateReason =
  | "ok"
  | "disabled"
  | "review_backlog"
  | "review_stale"
  | "budget_exhausted";

export interface RenderGateInputs {
  enabled: boolean;
  reviewDepth: number;
  reviewQueueCap: number;
  /** null when the review queue is empty. */
  oldestReviewAgeHours: number | null;
  staleHours: number;
  budgetExhausted: boolean;
}

export interface RenderGateDecision {
  shouldRender: boolean;
  reason: RenderGateReason;
}

/**
 * Pure backpressure decision. No DB, no clock: everything it needs is in
 * the inputs, so it is trivially unit-testable and the same logic runs
 * in the cron and (for display) in the admin status strip.
 *
 * Order of checks is the order of the admin message we want to show when
 * more than one condition is true: the kill switch first, then the two
 * "go approve things" signals (backlog, then stale), then budget. An
 * empty review queue (depth 0) never trips the stale gate, which is what
 * lets a fresh system with no approvals yet start dripping.
 */
export function evaluateRenderGate(i: RenderGateInputs): RenderGateDecision {
  if (!i.enabled) return { shouldRender: false, reason: "disabled" };
  if (i.reviewQueueCap > 0 && i.reviewDepth >= i.reviewQueueCap) {
    return { shouldRender: false, reason: "review_backlog" };
  }
  if (
    i.reviewDepth > 0 &&
    i.oldestReviewAgeHours !== null &&
    i.oldestReviewAgeHours >= i.staleHours
  ) {
    return { shouldRender: false, reason: "review_stale" };
  }
  if (i.budgetExhausted) {
    return { shouldRender: false, reason: "budget_exhausted" };
  }
  return { shouldRender: true, reason: "ok" };
}

export interface RenderGateStatus extends RenderGateDecision {
  /** The raw signals behind the decision, surfaced so the admin status
   *  strip can render "3 of 20 in review" without a second round of
   *  reads. */
  enabled: boolean;
  reviewDepth: number;
  reviewQueueCap: number;
  oldestReviewAgeHours: number | null;
  staleHours: number;
  budgetExhausted: boolean;
}

/**
 * Read every signal the gate needs and evaluate it. One call for both
 * the cron (which acts on shouldRender) and the admin UI (which shows
 * the reason and the raw numbers).
 */
export async function resolveRenderGate(
  nowMs: number = Date.now(),
): Promise<RenderGateStatus> {
  const [enabled, reviewQueueCap, staleHours, reviewDepth, oldestReviewAgeHours, budget] =
    await Promise.all([
      getRenderEnabled(),
      getReviewQueueCap(),
      getStaleHours(),
      countStoriesInReview(),
      getOldestReviewAgeHours(nowMs),
      getBudgetSummary(),
    ]);
  const inputs: RenderGateInputs = {
    enabled,
    reviewDepth,
    reviewQueueCap,
    oldestReviewAgeHours,
    staleHours,
    budgetExhausted: budget.exhausted,
  };
  return {
    ...evaluateRenderGate(inputs),
    ...inputs,
  };
}

/** One-line, human-readable explanation for the admin status strip. */
export function describeRenderGate(status: RenderGateStatus): string {
  switch (status.reason) {
    case "ok":
      return "Rendering active";
    case "disabled":
      return "Rendering off";
    case "review_backlog":
      return `Paused: review queue full (${status.reviewDepth}/${status.reviewQueueCap})`;
    case "review_stale":
      return `Paused: oldest review item is ${Math.floor(
        status.oldestReviewAgeHours ?? 0,
      )}h old, approve or reject to resume`;
    case "budget_exhausted":
      return "Paused: today's render budget is spent";
  }
}

// ---- eligibility + candidate selection -------------------------------

// Numeric weight per strength tier, matching the CASE expression the
// reddit-source table already sorts by. Higher renders first.
const STRENGTH_WEIGHT: Record<RedditSourceStrength, number> = {
  none: 0,
  medium: 1,
  strong: 2,
};

// SQL fragment mirroring reddit-source.ts STRENGTH_WEIGHT_CASE so the
// scheduler orders candidates identically to the admin table's
// "strength DESC" sort.
const STRENGTH_WEIGHT_SQL =
  "CASE strength WHEN 'strong' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END";

/** Minimum eligible strength, defaulting to "medium". An unknown stored
 *  value falls back to the default rather than silently widening the pool. */
export async function getEligibilityMinStrength(): Promise<RedditSourceStrength> {
  const raw = (await getSetting(RENDER_SETTING_KEYS.eligibilityMinStrength))
    ?.trim()
    .toLowerCase();
  if (raw === "none" || raw === "medium" || raw === "strong") return raw;
  return "medium";
}

/**
 * Pick the next `limit` reddit_ids to auto-render, highest priority first.
 *
 * Eligibility: status 'imported' (the available pool, same one Process N
 * draws from), strength at or above the configured minimum, and NOT
 * opted into the existing Full Pipeline auto-publish path (full_pipeline
 * 0 or NULL). Full-pipeline sources publish without the human gate, so
 * the approve-before-publish scheduler deliberately leaves them alone.
 *
 * Order: strength tier DESC, then engagement (comments) DESC, then
 * recency (date_written) DESC. This is strict tiers with an engagement
 * and recency tie-break, the v1 priority model.
 */
export async function selectRenderCandidates(
  limit: number,
  minStrength: RedditSourceStrength,
): Promise<string[]> {
  if (limit <= 0) return [];
  const rows = await all<{ reddit_id: string }>(
    `SELECT reddit_id FROM reddit_source
     WHERE status = 'imported'
       AND (full_pipeline IS NULL OR full_pipeline = 0)
       AND (${STRENGTH_WEIGHT_SQL}) >= ?
     ORDER BY (${STRENGTH_WEIGHT_SQL}) DESC,
              comments DESC,
              date_written DESC
     LIMIT ?`,
    [STRENGTH_WEIGHT[minStrength], limit],
  );
  return rows.map((r) => r.reddit_id);
}

// ---- the rate-limited drip -------------------------------------------

// Hard ceiling on a single tick's enqueue, independent of the token
// bucket. Bounds a catch-up burst after downtime so one cron firing can
// never dump hundreds of jobs; the review-headroom cap below is usually
// the tighter limit, this is the backstop.
export const MAX_ENQUEUE_PER_TICK = 25;

export type RenderDripReason =
  | "ok"
  | "gate_closed"
  | "seeded"
  | "no_allowance_yet"
  | "no_headroom"
  | "no_candidates";

export interface RenderDripResult {
  /** How many story_jobs rows this tick actually created. */
  enqueued: number;
  reason: RenderDripReason;
  /** The gate status, so the cron log (and a manual POST) can show why a
   *  tick did nothing. */
  gate: RenderGateStatus;
  /** Whole renders the token bucket allowed this tick (pre-headroom). */
  allowance: number;
  /** Renders review headroom allowed this tick (cap minus in-flight). */
  headroom: number;
}

/**
 * One tick of the render drip. Safe to call from the cron every few
 * minutes: it self-throttles.
 *
 * 1. Backpressure gate. Closed -> do nothing.
 * 2. Token bucket. Credits accrue at rate_per_hour since the last
 *    credited enqueue; only whole credits are spendable. First run (or a
 *    corrupt cursor) seeds the cursor to now and spends nothing, so the
 *    scheduler never bursts on its very first tick.
 * 3. Review headroom. Never enqueue more than (cap - inReview - inFlight)
 *    so an in-flight batch cannot overflow the review queue past its cap.
 * 4. Select highest-priority candidates and enqueue via the same
 *    bulkEnqueueStoryJobs the manual Process N uses.
 * 5. Advance the cursor by the credits actually consumed (preserving the
 *    fractional remainder) so the long-run average holds the target rate.
 */
export async function runRenderDrip(
  nowMs: number = Date.now(),
): Promise<RenderDripResult> {
  const gate = await resolveRenderGate(nowMs);
  const base = { gate, allowance: 0, headroom: 0 };
  if (!gate.shouldRender) {
    // Paused (disabled, backlog, stale, or budget). Reset the cursor so
    // credit does not bank while the drip cannot render; otherwise a long
    // pause would let the rate limit be bypassed in a burst on resume.
    await setSetting(
      RENDER_SETTING_KEYS.lastEnqueueAt,
      new Date(nowMs).toISOString(),
    );
    return { enqueued: 0, reason: "gate_closed", ...base };
  }

  const ratePerHour = await getRenderRatePerHour();

  // Token bucket cursor. A missing/corrupt cursor seeds to now and spends
  // nothing this tick (no first-run burst).
  const lastRaw = await getSetting(RENDER_SETTING_KEYS.lastEnqueueAt);
  const lastMs = lastRaw ? Date.parse(lastRaw) : NaN;
  if (!Number.isFinite(lastMs)) {
    await setSetting(
      RENDER_SETTING_KEYS.lastEnqueueAt,
      new Date(nowMs).toISOString(),
    );
    return { enqueued: 0, reason: "seeded", ...base };
  }

  const elapsedHours = Math.max(0, (nowMs - lastMs) / 3_600_000);
  const allowance = Math.floor(elapsedHours * ratePerHour);
  if (allowance <= 0) {
    return { enqueued: 0, reason: "no_allowance_yet", ...base };
  }

  // Review headroom: reviewed-but-unpublished stories plus everything
  // still in flight (queued/processing) must not exceed the cap once the
  // in-flight work lands in review.
  const inFlight = await countPendingStoryJobs();
  const headroom = Math.max(0, gate.reviewQueueCap - gate.reviewDepth - inFlight);
  const want = Math.min(allowance, MAX_ENQUEUE_PER_TICK, headroom);
  if (want <= 0) {
    // In-flight work already fills the review headroom. Reset the cursor
    // for the same reason as the gate-closed path: don't bank credit while
    // we can't act on it.
    await setSetting(
      RENDER_SETTING_KEYS.lastEnqueueAt,
      new Date(nowMs).toISOString(),
    );
    return { enqueued: 0, reason: "no_headroom", ...base, allowance };
  }

  const minStrength = await getEligibilityMinStrength();
  const candidates = await selectRenderCandidates(want, minStrength);
  if (candidates.length === 0) {
    // Nothing eligible right now. Advance the cursor to now so allowance
    // does not pile up unbounded for a future flood of sources.
    await setSetting(
      RENDER_SETTING_KEYS.lastEnqueueAt,
      new Date(nowMs).toISOString(),
    );
    return { enqueued: 0, reason: "no_candidates", ...base, allowance, headroom };
  }

  const result = await bulkEnqueueStoryJobs(candidates, {
    requested_by: RENDER_SCHEDULER_REQUESTED_BY,
  });
  const enqueued = result.enqueued;

  // Advance the cursor. When at least one job landed, advance by the
  // credits consumed and keep the remainder so the average rate holds.
  // When nothing landed (a rare enqueue race), advance to now anyway so a
  // permanently-unenqueueable candidate cannot spin the drip hot.
  const newLastMs =
    enqueued > 0
      ? Math.min(lastMs + (enqueued / ratePerHour) * 3_600_000, nowMs)
      : nowMs;
  await setSetting(
    RENDER_SETTING_KEYS.lastEnqueueAt,
    new Date(newLastMs).toISOString(),
  );

  return { enqueued, reason: "ok", ...base, allowance, headroom };
}

// ---- stale-review garbage collection ---------------------------------

export interface ExpireStaleResult {
  /** Stories archived this run. */
  expired: number;
  /** The updated_at cutoff used (ISO). Anything older was eligible. */
  cutoff: string;
  /** The ids archived, for the cron log. */
  ids: string[];
}

/**
 * Archive scheduler-created stories that have sat in `review` past the
 * freshness TTL without a human approving them. A ten-day-old
 * Reddit-derived short is dead weight; left alone it fills the review
 * queue and (via backpressure) stalls fresh rendering.
 *
 * Scope is deliberately narrow: only stories whose story_job was enqueued
 * by the render scheduler (requested_by = RENDER_SCHEDULER_REQUESTED_BY)
 * are touched. A story a human created or is intentionally holding in
 * review is never archived out from under them. "Age" is updated_at, so
 * anything an admin has touched recently is safe even if it was
 * scheduler-created.
 */
export async function expireStaleReviews(
  nowMs: number = Date.now(),
): Promise<ExpireStaleResult> {
  const ttlDays = await getFreshnessTtlDays();
  const cutoff = new Date(nowMs - ttlDays * 86_400_000).toISOString();

  const rows = await all<{ id: string }>(
    `SELECT s.id FROM stories s
     WHERE s.status = 'review'
       AND s.updated_at IS NOT NULL
       AND s.updated_at < ?
       AND s.id IN (
         SELECT story_id FROM story_jobs
         WHERE requested_by = ? AND story_id IS NOT NULL
       )`,
    [cutoff, RENDER_SCHEDULER_REQUESTED_BY],
  );
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { expired: 0, cutoff, ids };

  const now = new Date(nowMs).toISOString();
  // Chunked UPDATE, guarded on status='review' so a story a human just
  // published in the race window is not clobbered back to archived.
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(", ");
    await run(
      `UPDATE stories SET status = 'archived', updated_at = ?
       WHERE status = 'review' AND id IN (${placeholders})`,
      [now, ...batch],
    );
  }
  return { expired: ids.length, cutoff, ids };
}
