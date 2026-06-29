// The render spend cap for user submissions (Phase 3). enqueueShortRender has no
// budget gate of its own, and the existing pipeline.story_jobs cap guards only the
// Reddit pipeline, so this is the hard control on submission video cost (~$1 each).
// Checked in the approve-and-render action: when the cap is reached the approval
// is refused with a visible reason (the reviewer can approve poll-only or wait),
// never a silent overspend.
//
// Count-based estimate, like lib/story-jobs-budget.ts: a safety net, not exact
// accounting (stories.cost_cents is not reliably populated at approval time).
//
// Plan: _plans/2026-06-29-user-submitted-stories.md (Phase 3).

import "server-only";
import { one } from "@/lib/db";
import { getSetting } from "@/lib/repo";

export const RENDER_BUDGET_CAP_SETTING_KEY = "submissions.render.daily_cap_cents";
/** $20/day conservative pilot default (set with Amit before opening up). */
const DEFAULT_CAP_CENTS = 2000;
/** ~$1 per generated short (mostly the AI scene images). */
export const ESTIMATED_RENDER_COST_CENTS = 100;

export interface RenderBudget {
  capCents: number;
  spentTodayCents: number;
  remainingCents: number;
  /** True when one more render would exceed the cap. */
  exhausted: boolean;
}

function startOfUtcDayIso(now: number): string {
  const d = new Date(now);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  ).toISOString();
}

export async function getRenderBudget(now = Date.now()): Promise<RenderBudget> {
  const raw = (await getSetting(RENDER_BUDGET_CAP_SETTING_KEY))?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const capCents =
    Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CAP_CENTS;

  // Estimate today's submission render spend: count submissions that were
  // approved-with-video today (UTC), times the per-render estimate.
  const since = startOfUtcDayIso(now);
  const row = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM submissions
      WHERE story_id IS NOT NULL AND render_choice = 'video'
        AND approved_at IS NOT NULL AND approved_at >= ?`,
    [since],
  );
  const count = Number(row?.n ?? 0);
  const spentTodayCents = count * ESTIMATED_RENDER_COST_CENTS;
  const remainingCents = Math.max(0, capCents - spentTodayCents);
  const exhausted = spentTodayCents + ESTIMATED_RENDER_COST_CENTS > capCents;

  return { capCents, spentTodayCents, remainingCents, exhausted };
}
