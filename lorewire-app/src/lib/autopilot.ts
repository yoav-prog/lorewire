// Autopilot: the hands-off lane of the scheduler.
//
// Autopilot pulls eligible Reddit sources (tier configurable via
// autopilot.min_strength, default STRONG) up to a daily limit, lets the
// normal pipeline render them, and — in live/autonomous mode — approves
// the finished stories through the exact same publishStoryIfReady() +
// scheduleStoryPublish() path a human Approve uses. One publish path:
// slots, caps, and dedup all still apply.
//
// Trust is earned in stages:
//   off        — nothing happens (default).
//   shadow     — autopilot pulls and renders, but every story stops in
//                the review queue tagged "autopilot" so a human can
//                eyeball a week of what WOULD have been published.
//   live       — a safety judge screens each rendered story; clean ones
//                publish, doubtful ones hold in review for a human. Pulls
//                only when the human review queue is empty (a fallback,
//                not a firehose — manual curation stays primary).
//   autonomous — same as live but runs continuously: it does NOT wait for
//                the human queue to empty, and bounds only its own review
//                footprint. Fully hands-off (owner choice, 2026-07-08).
//                The judge still screens every story; doubtful ones hold.
//
// Source strength is a triage/volume tier, not a safety gate (it ranks
// source potential for a human who was going to read the story anyway),
// so no mode publishes on tier alone: the judge screens the actual
// generated story, and any judge failure fails closed to a human. A
// circuit breaker flips autopilot off after consecutive publish
// EXCEPTIONS (systemic failures: DB down, network dead) and emails the
// admin — nobody is awake to notice a 3am log line. A publish-gate
// refusal is a per-story problem, not a systemic one: it defers a few
// ticks (so asset backfill can land) and then holds the story for a
// human, without ever feeding the breaker — on 2026-07-09 one degenerate
// story retried every tick tripped the breaker and took the whole
// autonomous lane down four minutes after its first pull.
//
// Plans: _plans/2026-07-02-scheduler-autopilot-and-flexible-slots.md,
// _plans/2026-07-08-autopilot-autonomous-mode.md,
// _plans/2026-07-09-autopilot-gate-refusal-hold-and-degenerate-guard.md.

import "server-only";

import { all, one } from "@/lib/db";
import { getSetting, setSetting } from "@/lib/repo";
import { getBudgetSummary } from "@/lib/story-jobs-budget";
import { bulkEnqueueStoryJobs, countPendingStoryJobs } from "@/lib/story-jobs";
import {
  countStoriesInReview,
  getReviewQueueCap,
  selectRenderCandidates,
} from "@/lib/render-scheduler";
import { type RedditSourceStrength } from "@/lib/reddit-source";
import {
  approveReviewedStory,
  type ApproveBreaker,
  type ApproveCandidate,
} from "@/lib/approve-reviewed-story";
import { sendBrevoEmail } from "@/lib/email";

// The safety judge moved to its own module (2026-07-12) so the render-
// scheduler auto-publish lane screens through the same gate. Re-exported
// here so existing importers (and tests) keep resolving it from autopilot.
export {
  detectDegenerateStory,
  screenStoryForAutopilot,
} from "@/lib/story-safety-judge";
export type {
  AutopilotJudgeOutput,
  AutopilotScreenResult,
} from "@/lib/story-safety-judge";

// ---- settings keys + defaults ----------------------------------------

export const AUTOPILOT_SETTING_KEYS = {
  /** "off" | "shadow" | "live". Defaults OFF; an unknown value reads as off. */
  mode: "autopilot.mode",
  /** Max sources autopilot pulls per UTC day. Default 1: unattended
   *  publishing earns trust one post at a time. */
  dailyLimit: "autopilot.daily_limit",
  /** Minimum source strength autopilot will pull: "none" (all, default),
   *  "medium", or "strong". Narrowing trades volume for quality; the
   *  safety judge screens every story regardless of tier. */
  minStrength: "autopilot.min_strength",
  /** Where the circuit-breaker alert email goes. Blank = log only. */
  alertEmail: "autopilot.alert_email",
  /** Internal: consecutive publish failures. The breaker trips at the
   *  threshold and flips mode off. */
  consecutiveFailures: "autopilot.consecutive_failures",
  /** Internal: ISO timestamp of the last breaker trip, for the UI banner. */
  trippedAt: "autopilot.tripped_at",
} as const;

export const AUTOPILOT_DEFAULTS = {
  dailyLimit: 1,
  breakerThreshold: 3,
  /** Publish-gate refusals a story gets before it is held for a human.
   *  Below this the story stays a candidate and the next tick retries,
   *  giving the asset-backfill crons ~8-10 minutes (2-min cadence) to
   *  land a transiently missing thumbnail/poll. Gate refusals never
   *  feed the breaker — one bad story must not disable autopilot. */
  gateRefusalHoldAfter: 5,
} as const;

/** Stamped on story_jobs.requested_by for every row autopilot enqueues,
 *  so its stories are distinguishable everywhere (queue badges, the
 *  empty-queue gate, provenance). */
export const AUTOPILOT_REQUESTED_BY = "autopilot";

export type AutopilotMode = "off" | "shadow" | "live" | "autonomous";

// ---- setting readers ---------------------------------------------------

export async function getAutopilotMode(): Promise<AutopilotMode> {
  const raw = (await getSetting(AUTOPILOT_SETTING_KEYS.mode))?.trim().toLowerCase();
  if (raw === "shadow" || raw === "live" || raw === "autonomous") return raw;
  return "off";
}

export async function getAutopilotDailyLimit(): Promise<number> {
  const raw = await getSetting(AUTOPILOT_SETTING_KEYS.dailyLimit);
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return AUTOPILOT_DEFAULTS.dailyLimit;
  return Math.floor(n);
}

export async function getAutopilotAlertEmail(): Promise<string | null> {
  const raw = (await getSetting(AUTOPILOT_SETTING_KEYS.alertEmail))?.trim();
  return raw && raw.includes("@") ? raw : null;
}

/** Minimum source strength autopilot will pull, defaulting to "none"
 *  (all tiers). The original 2026-07-02 design defaulted to "strong", but
 *  real pools are dominated by unrated ("none") sources — in production,
 *  ~30k of ~30.5k imported sources are unrated and essentially zero strong
 *  sources are ever eligible — so a "strong" default silently pulled
 *  nothing. "none" makes the setting match the data; narrowing to "medium"
 *  or "strong" is an explicit admin choice. An unknown stored value falls
 *  back to "none". Tier is a volume/quality dial — the safety judge screens
 *  every rendered story regardless of tier, so the default does not weaken
 *  the safety gate. */
export async function getAutopilotMinStrength(): Promise<RedditSourceStrength> {
  const raw = (await getSetting(AUTOPILOT_SETTING_KEYS.minStrength))
    ?.trim()
    .toLowerCase();
  if (raw === "none" || raw === "medium" || raw === "strong") return raw;
  return "none";
}

// ---- queue reads -------------------------------------------------------

/** Review-queue depth EXCLUDING autopilot's own stories. This is the
 *  "is the human's plate empty" signal that gates the pull: autopilot's
 *  in-transit (or held) items must not block the next pull — the daily
 *  limit and review headroom bound those. */
export async function countHumanReviewDepth(): Promise<number> {
  const row = await one<{ n: number | string }>(
    `SELECT count(*) AS n FROM stories s
     WHERE s.status = 'review'
       AND s.id NOT IN (
         SELECT story_id FROM story_jobs
         WHERE requested_by = ? AND story_id IS NOT NULL
       )`,
    [AUTOPILOT_REQUESTED_BY],
  );
  return Number(row?.n ?? 0);
}

/** Sources autopilot has pulled since UTC midnight. UTC keeps the count
 *  independent of any platform timezone; the limit is a volume bound,
 *  not a wall-clock schedule. */
export async function countAutopilotPullsToday(
  nowMs: number = Date.now(),
): Promise<number> {
  const now = new Date(nowMs);
  const dayStartIso = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const row = await one<{ n: number | string }>(
    "SELECT count(*) AS n FROM story_jobs WHERE requested_by = ? AND requested_at >= ?",
    [AUTOPILOT_REQUESTED_BY, dayStartIso],
  );
  return Number(row?.n ?? 0);
}

/** Autopilot's own in-flight jobs (queued or processing). Used only by
 *  the autonomous-mode headroom calc, which bounds autopilot's OWN review
 *  footprint rather than total review depth — a manual backlog must not
 *  starve the autonomous lane. */
export async function countAutopilotInFlight(): Promise<number> {
  const row = await one<{ n: number | string }>(
    `SELECT count(*) AS n FROM story_jobs
     WHERE requested_by = ? AND status IN ('queued', 'processing')`,
    [AUTOPILOT_REQUESTED_BY],
  );
  return Number(row?.n ?? 0);
}

// ---- the pull tick -----------------------------------------------------

export type AutopilotPullReason =
  | "ok"
  | "off"
  | "budget_exhausted"
  | "queue_not_empty"
  | "daily_limit_reached"
  | "no_headroom"
  | "no_candidates";

export interface AutopilotPullResult {
  enqueued: number;
  reason: AutopilotPullReason;
  mode: AutopilotMode;
  humanReviewDepth: number;
  usedToday: number;
  dailyLimit: number;
}

/**
 * One pull tick. Runs in shadow, live, and autonomous. Gates, in order:
 * mode, budget, human queue empty (SKIPPED in autonomous), daily limit,
 * review headroom (total review depth in shadow/live; autopilot-only
 * footprint in autonomous), eligible candidates at or above
 * autopilot.min_strength. Everything defaults closed.
 */
export async function runAutopilotPull(
  nowMs: number = Date.now(),
): Promise<AutopilotPullResult> {
  const mode = await getAutopilotMode();
  const [humanReviewDepth, usedToday, dailyLimit] = await Promise.all([
    countHumanReviewDepth(),
    countAutopilotPullsToday(nowMs),
    getAutopilotDailyLimit(),
  ]);
  const base = { mode, humanReviewDepth, usedToday, dailyLimit };

  if (mode === "off") return { enqueued: 0, reason: "off", ...base };

  const budget = await getBudgetSummary();
  if (budget.exhausted) {
    return { enqueued: 0, reason: "budget_exhausted", ...base };
  }
  // The empty-queue gate is the "fallback, not a firehose" rule for
  // shadow/live: autopilot waits until the human's plate is clear.
  // Autonomous drops it on purpose — it runs continuously and publishes
  // past a non-empty review queue (owner choice, 2026-07-08).
  if (mode !== "autonomous" && humanReviewDepth > 0) {
    return { enqueued: 0, reason: "queue_not_empty", ...base };
  }
  const remaining = dailyLimit - usedToday;
  if (remaining <= 0) {
    return { enqueued: 0, reason: "daily_limit_reached", ...base };
  }

  // Review headroom. Shadow/live bound TOTAL review depth so autopilot's
  // held/shadow items can't push the human queue past its cap. Autonomous
  // bypasses the human queue on purpose, so it bounds only its OWN
  // footprint (autopilot's held/in-review stories + its in-flight jobs);
  // a manual backlog must not starve it. Daily limit + budget stay the
  // primary volume bounds.
  const reviewCap = await getReviewQueueCap();
  let headroom: number;
  if (mode === "autonomous") {
    const [totalInReview, autopilotInFlight] = await Promise.all([
      countStoriesInReview(),
      countAutopilotInFlight(),
    ]);
    const autopilotReviewDepth = Math.max(0, totalInReview - humanReviewDepth);
    headroom = Math.max(0, reviewCap - autopilotReviewDepth - autopilotInFlight);
  } else {
    const [totalInReview, inFlight] = await Promise.all([
      countStoriesInReview(),
      countPendingStoryJobs(),
    ]);
    headroom = Math.max(0, reviewCap - totalInReview - inFlight);
  }
  const want = Math.min(remaining, headroom);
  if (want <= 0) {
    return { enqueued: 0, reason: "no_headroom", ...base };
  }

  // Tier is a volume/quality dial (autopilot.min_strength), not a safety
  // gate — the judge screens every rendered story regardless of tier.
  // Default "strong" preserves the original councilled behaviour.
  const minStrength = await getAutopilotMinStrength();
  const candidates = await selectRenderCandidates(want, minStrength);
  if (candidates.length === 0) {
    return { enqueued: 0, reason: "no_candidates", ...base };
  }

  const result = await bulkEnqueueStoryJobs(candidates, {
    requested_by: AUTOPILOT_REQUESTED_BY,
  });
  return { enqueued: result.enqueued, reason: "ok", ...base };
}

// ---- the approve tick --------------------------------------------------

export type AutopilotApproveReason = "ok" | "not_live" | "no_candidates";

export interface AutopilotApproveResult {
  reason: AutopilotApproveReason;
  approved: number;
  held: number;
  /** Stories whose publish gate refused but that stay candidates for the
   *  next tick (asset backfill may still land). Held after the
   *  gateRefusalHoldAfter threshold. */
  deferred: number;
  failed: number;
  skipped: number;
  /** True when this tick tripped the circuit breaker (mode is now off). */
  tripped: boolean;
}

// Stories one approve tick handles. Publishing schedules four platforms
// of work per story; keep the batch small and let the 2-minute cadence
// carry the volume.
const APPROVE_BATCH_LIMIT = 3;

// Rendered autopilot stories waiting in review, oldest first, excluding
// anything the judge already held (held stories belong to the human now).
async function selectApproveCandidates(): Promise<ApproveCandidate[]> {
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
     LIMIT ${APPROVE_BATCH_LIMIT}`,
    [AUTOPILOT_REQUESTED_BY],
  );
}

/**
 * One approve tick (live and autonomous; shadow/off stop at the review
 * queue). Each candidate is screened, then pushed through the exact
 * human-approve path. Idempotent under overlapping crons:
 * publishStoryIfReady reports an already-published story as
 * not_ready/already_published (counted as skipped, not failed) and
 * scheduleStoryPublish dedupes per (story, platform) on a partial unique
 * index.
 */
export async function runAutopilotApprove(
  nowMs: number = Date.now(),
): Promise<AutopilotApproveResult> {
  const mode = await getAutopilotMode();
  if (mode !== "live" && mode !== "autonomous") {
    return { reason: "not_live", approved: 0, held: 0, deferred: 0, failed: 0, skipped: 0, tripped: false };
  }

  const candidates = await selectApproveCandidates();
  if (candidates.length === 0) {
    return { reason: "no_candidates", approved: 0, held: 0, deferred: 0, failed: 0, skipped: 0, tripped: false };
  }

  let approved = 0;
  let held = 0;
  let deferred = 0;
  let failed = 0;
  let skipped = 0;
  let tripped = false;

  // Autopilot's own circuit breaker: consecutive EXCEPTIONS flip
  // autopilot.mode off. Injected into the shared approve step so a systemic
  // failure disables autopilot specifically, not the other publish lanes.
  const breaker: ApproveBreaker = {
    recordFailure: (storyId, reason, ms) =>
      recordAutopilotFailure(storyId, reason, ms),
    resetFailures: resetAutopilotFailures,
  };

  for (const story of candidates) {
    const result = await approveReviewedStory(story, {
      decidedBy: AUTOPILOT_REQUESTED_BY,
      gateRefusalHoldAfter: AUTOPILOT_DEFAULTS.gateRefusalHoldAfter,
      breaker,
      logLabel: "autopilot",
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

// ---- circuit breaker ---------------------------------------------------

async function getConsecutiveFailures(): Promise<number> {
  const raw = await getSetting(AUTOPILOT_SETTING_KEYS.consecutiveFailures);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export async function resetAutopilotFailures(): Promise<void> {
  await setSetting(AUTOPILOT_SETTING_KEYS.consecutiveFailures, "0");
}

/** Count one publish failure; at the threshold, flip autopilot off,
 *  stamp the trip time, and alert the admin. Returns whether this
 *  failure tripped the breaker. */
async function recordAutopilotFailure(
  storyId: string,
  reason: string,
  nowMs: number,
): Promise<boolean> {
  const failures = (await getConsecutiveFailures()) + 1;
  await setSetting(AUTOPILOT_SETTING_KEYS.consecutiveFailures, String(failures));
  if (failures < AUTOPILOT_DEFAULTS.breakerThreshold) return false;

  await setSetting(AUTOPILOT_SETTING_KEYS.mode, "off");
  await setSetting(AUTOPILOT_SETTING_KEYS.trippedAt, new Date(nowMs).toISOString());
  console.error("[autopilot breaker] tripped — autopilot disabled", {
    failures,
    last_story_id: storyId,
    last_reason: reason.slice(0, 200),
  });

  const alertEmail = await getAutopilotAlertEmail();
  if (alertEmail) {
    const text =
      `Lorewire autopilot switched itself off after ${failures} consecutive publish failures.\n\n` +
      `Last story: ${storyId}\nLast error: ${reason.slice(0, 300)}\n\n` +
      `Nothing else will publish automatically until you turn autopilot back on at /admin/scheduler.`;
    const sent = await sendBrevoEmail({
      to: alertEmail,
      subject: "Lorewire autopilot disabled itself",
      html: `<p>${text.replace(/\n/g, "<br/>")}</p>`,
      text,
    });
    console.info("[autopilot breaker] alert email", {
      to: alertEmail,
      ok: sent.ok,
      error: sent.error ?? null,
    });
  }
  return true;
}

// ---- recent auto-publishes ----------------------------------------------

export interface RecentAutoPublish {
  storyId: string;
  title: string | null;
  status: string;
  decidedAt: string;
}

/** The latest stories autopilot published, newest first, for the
 *  scheduler page's retract list. Status comes along so an already
 *  retracted story shows as archived instead of offering a second
 *  retract. */
export async function listRecentAutoPublishes(
  limit = 10,
): Promise<RecentAutoPublish[]> {
  // GROUP BY story_id: overlapping cron ticks can double-log a decision,
  // and one story must appear once no matter how it got recorded.
  const rows = await all<{
    story_id: string;
    title: string | null;
    status: string;
    decided_at: string;
  }>(
    `SELECT d.story_id, s.title, s.status, MAX(d.decided_at) AS decided_at
     FROM scheduler_decisions d
     JOIN stories s ON s.id = d.story_id
     WHERE d.decision = 'auto_approved'
     GROUP BY d.story_id, s.title, s.status
     ORDER BY decided_at DESC
     LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({
    storyId: r.story_id,
    title: r.title,
    status: r.status,
    decidedAt: r.decided_at,
  }));
}

// ---- admin overview ----------------------------------------------------

export interface AutopilotStatus {
  mode: AutopilotMode;
  dailyLimit: number;
  minStrength: RedditSourceStrength;
  usedToday: number;
  humanReviewDepth: number;
  alertEmail: string | null;
  trippedAt: string | null;
  consecutiveFailures: number;
  /** Human track record on STRONG sources, the empirical basis for
   *  trusting autopilot with them. */
  strongApproved: number;
  strongRejected: number;
  autoApproved: number;
  autoHeld: number;
}

export async function getAutopilotStatus(
  nowMs: number = Date.now(),
): Promise<AutopilotStatus> {
  const [
    mode,
    dailyLimit,
    minStrength,
    usedToday,
    humanReviewDepth,
    alertEmail,
    trippedAt,
    failures,
    decisions,
  ] = await Promise.all([
    getAutopilotMode(),
    getAutopilotDailyLimit(),
    getAutopilotMinStrength(),
    countAutopilotPullsToday(nowMs),
    countHumanReviewDepth(),
    getAutopilotAlertEmail(),
    getSetting(AUTOPILOT_SETTING_KEYS.trippedAt),
    getConsecutiveFailures(),
    all<{ decision: string; tier: string | null; n: number | string }>(
      `SELECT decision, tier, count(*) AS n FROM scheduler_decisions
       GROUP BY decision, tier`,
      [],
    ),
  ]);

  let strongApproved = 0;
  let strongRejected = 0;
  let autoApproved = 0;
  let autoHeld = 0;
  for (const d of decisions) {
    const n = Number(d.n);
    if (d.decision === "approved" && d.tier === "strong") strongApproved += n;
    if (d.decision === "rejected" && d.tier === "strong") strongRejected += n;
    if (d.decision === "auto_approved") autoApproved += n;
    if (d.decision === "auto_held") autoHeld += n;
  }

  return {
    mode,
    dailyLimit,
    minStrength,
    usedToday,
    humanReviewDepth,
    alertEmail,
    trippedAt: trippedAt?.trim() || null,
    consecutiveFailures: failures,
    strongApproved,
    strongRejected,
    autoApproved,
    autoHeld,
  };
}
