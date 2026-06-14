// Daily-budget cap for the story_jobs queue.
//
// Phase 7 of _plans/2026-06-14-story-jobs-followups.md. Mirrors
// frame-session-spend.ts in shape, scoped to "today UTC" instead of "this
// editor session." Read paths are server-only; the cap setter is a
// server action in admin/actions.ts.
//
// Cost model is intentionally count-based, not summed from
// `stories.cost_cents` — the worker doesn't reliably populate that column
// yet, and the gate's job is to be a safety net not a precise accountant.
// Real per-story cost capture is its own micro-phase; this estimate gives
// the admin enough signal to set a reasonable cap and trust it.

import "server-only";

import { one } from "@/lib/db";
import { getSetting } from "@/lib/repo";

export const DAILY_BUDGET_CAP_SETTING_KEY =
  "pipeline.story_jobs.daily_cap_cents";

// Same value as ESTIMATED_JOB_COST_CENTS in
// pipeline/story_jobs_worker.py. They MUST stay in sync — the worker's
// pre-claim gate uses the Python constant; this module surfaces the
// projected spend to the admin UI; both numbers have to read off the
// same per-job assumption or the UI will tell the admin "you have
// budget" while the worker is actually blocked.
export const ESTIMATED_JOB_COST_CENTS = 50;

/**
 * Today's daily-budget cap, in cents. `null` means no cap (unlimited).
 * Negative or non-numeric stored values are also treated as no cap so
 * a corrupt setting can't passively block all processing.
 */
export async function getDailyBudgetCapCents(): Promise<number | null> {
  const raw = await getSetting(DAILY_BUDGET_CAP_SETTING_KEY);
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export interface TodayStoryJobsEstimate {
  /** done jobs that finished today + currently-active jobs. */
  count: number;
  /** count × ESTIMATED_JOB_COST_CENTS. */
  estimatedSpendCents: number;
}

/**
 * Project today's story_jobs spend using the same shape the worker uses.
 * Day boundary is UTC; "today" is `now()` in UTC. Active jobs (queued or
 * processing) are included regardless of when they were requested so a
 * row queued at 23:59 UTC yesterday that resolves today still gets
 * counted toward today.
 *
 * `estimatedSpendCents` is `count × ESTIMATED_JOB_COST_CENTS`.
 */
export async function getTodayStoryJobsEstimate(): Promise<TodayStoryJobsEstimate> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const dayStart = `${today}T00:00:00`;
  const dayEnd = `${today}T23:59:59.999999`;
  // ISO timestamps sort lexicographically the same as chronologically,
  // so a range compare on the TEXT column is fine without any date
  // coercion. Matches what pipeline/store.py uses.
  const row = await one<{ n: number | string }>(
    `SELECT count(*) AS n FROM story_jobs ` +
      `WHERE (status = 'done' AND finished_at >= ? AND finished_at < ?) ` +
      `OR status IN ('queued', 'processing')`,
    [dayStart, dayEnd],
  );
  const count = Number(row?.n ?? 0);
  return {
    count,
    estimatedSpendCents: count * ESTIMATED_JOB_COST_CENTS,
  };
}

/** Convenience for admin UI: "$1.50" / "$0.00". */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export interface BudgetSummary {
  /** Cap in cents; null when unset. */
  capCents: number | null;
  /** Count-based projection so far today (jobs × $0.50). The worker gate
   *  uses this exact number; admin UI shows it as the primary figure. */
  spentCents: number;
  /** Actual billed cents summed from stories.cost_cents for today. Stays
   *  at 0 when no story has the column populated (older rows pre-date
   *  the cost-capture wiring). When > 0, the UI surfaces this alongside
   *  the projection so the admin sees "what really happened" vs the
   *  conservative gate input. */
  actualCents: number;
  /** Active + done-today job count. */
  jobCount: number;
  /** `spentCents / capCents` as 0–1; 1.0 when capped, 0 when no cap. */
  fraction: number;
  /** True when the next job would push past the cap. */
  exhausted: boolean;
}

/**
 * Sum of stories.cost_cents for stories created today (UTC). Returns 0
 * when no row has the column populated. Mirrors
 * pipeline/store.py:today_actual_story_cost_cents — both sides do the
 * same range compare on the TEXT created_at column.
 */
export async function getTodayActualSpendCents(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const dayStart = `${today}T00:00:00`;
  const dayEnd = `${today}T23:59:59.999999`;
  const row = await one<{ total: number | string }>(
    `SELECT COALESCE(SUM(cost_cents), 0) AS total FROM stories ` +
      `WHERE created_at >= ? AND created_at < ? AND cost_cents IS NOT NULL`,
    [dayStart, dayEnd],
  );
  return Number(row?.total ?? 0);
}

/**
 * One-stop read for the admin UI. Bundles cap + projected spend +
 * actual billed + the derived "would the next job be blocked" flag.
 */
export async function getBudgetSummary(): Promise<BudgetSummary> {
  const [capCents, today, actualCents] = await Promise.all([
    getDailyBudgetCapCents(),
    getTodayStoryJobsEstimate(),
    getTodayActualSpendCents(),
  ]);
  const spentCents = today.estimatedSpendCents;
  const fraction =
    capCents !== null && capCents > 0
      ? Math.min(spentCents / capCents, 1)
      : 0;
  const exhausted =
    capCents !== null && spentCents + ESTIMATED_JOB_COST_CENTS > capCents;
  return {
    capCents,
    spentCents,
    actualCents,
    jobCount: today.count,
    fraction,
    exhausted,
  };
}
