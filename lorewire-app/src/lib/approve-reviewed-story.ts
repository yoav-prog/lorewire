// The shared per-story approve step for every unattended-publish lane.
//
// Both autopilot (its own pulled stories) and the render-scheduler
// auto-publish lane push a reviewed story through the EXACT same sequence:
//   1. safety screen (degenerate guard + LLM judge) — hold if unsafe,
//   2. publish gate (publishStoryIfReady: asset completeness + self-heal),
//   3. schedule the social posts (scheduleStoryPublish),
//   4. gate-refusal ladder: a per-story content/asset refusal defers a few
//      ticks (asset backfill may land) and then holds for a human — it
//      NEVER feeds the circuit breaker (2026-07-09 incident: one degenerate
//      story retried every tick tripped the breaker and took the lane down),
//   5. circuit breaker: only a thrown EXCEPTION (systemic: DB down, network
//      dead) counts, via the lane's injected breaker.
//
// Extracted from autopilot.ts (2026-07-12) so this logic lives in exactly
// one place (rule 20). The breaker is injected so a systemic failure in one
// lane disables THAT lane, not the other.

import "server-only";

import { one } from "@/lib/db";
import { getRedditSource } from "@/lib/reddit-source";
import { publishStoryIfReady } from "@/lib/auto-publish";
import { logSchedulerDecision, scheduleStoryPublish } from "@/lib/publish-scheduler";
import { screenStoryForAutopilot } from "@/lib/story-safety-judge";

export interface ApproveCandidate {
  id: string;
  reddit_id: string | null;
  title: string | null;
  body: string | null;
}

/** What a lane must supply to trip/reset its OWN circuit breaker. Keeps the
 *  shared step lane-agnostic: autopilot flips autopilot.mode, the render
 *  lane flips render.auto_publish. `recordFailure` returns whether this
 *  failure tripped the breaker. */
export interface ApproveBreaker {
  recordFailure: (storyId: string, reason: string, nowMs: number) => Promise<boolean>;
  resetFailures: () => Promise<void>;
}

export interface ApproveStoryOptions {
  /** Stamped on scheduler_decisions.decided_by + scheduleStoryPublish. */
  decidedBy: string;
  /** Refusals a story absorbs before it is held for a human. */
  gateRefusalHoldAfter: number;
  /** The lane's own circuit breaker. */
  breaker: ApproveBreaker;
  /** Bracketed log namespace for the lane ("autopilot", "render-autopublish"). */
  logLabel: string;
  nowMs: number;
}

export type ApproveOutcome =
  | "approved"
  | "held"
  | "deferred"
  | "skipped"
  | "failed";

export interface ApproveStoryResult {
  outcome: ApproveOutcome;
  /** True only when a thrown exception tripped the lane's breaker. */
  tripped: boolean;
}

// Publish-gate refusals recorded for one story across ticks. Drives the
// defer-then-hold ladder; the decision log doubles as the counter so no new
// table or column is needed. Story-scoped, so it counts refusals from any
// lane — a story handed between lanes still converges on the same hold.
export async function countGateRefusals(storyId: string): Promise<number> {
  const row = await one<{ n: number | string }>(
    "SELECT count(*) AS n FROM scheduler_decisions WHERE story_id = ? AND decision = 'auto_gate_refused'",
    [storyId],
  );
  return Number(row?.n ?? 0);
}

/**
 * Screen one reviewed story and, if it passes, publish it through the shared
 * gate + scheduler. Idempotent under overlapping crons: an already-published
 * story comes back skipped (not failed); scheduleStoryPublish dedupes per
 * (story, platform). Returns the outcome + whether the breaker tripped.
 */
export async function approveReviewedStory(
  story: ApproveCandidate,
  opts: ApproveStoryOptions,
): Promise<ApproveStoryResult> {
  const { decidedBy, gateRefusalHoldAfter, breaker, logLabel, nowMs } = opts;

  const source = story.reddit_id ? await getRedditSource(story.reddit_id) : null;
  const decisionSignals = {
    redditId: story.reddit_id ?? null,
    tier: source?.strength ?? null,
    comments: source?.comments ?? null,
    subreddit: source?.subreddit ?? null,
    decidedBy,
  };

  // Screen the generated story, not the source tier. A hold is final for the
  // lane: the decision row keeps it out of future ticks and it waits in
  // review for a human.
  const screen = await screenStoryForAutopilot(story);
  console.info("[autopilot safety]", {
    story_id: story.id,
    safe: screen.safe,
    category: screen.category,
    confidence: screen.confidence,
  });
  if (!screen.safe) {
    await logSchedulerDecision(
      { storyId: story.id, decision: "auto_held", ...decisionSignals },
      nowMs,
    );
    return { outcome: "held", tripped: false };
  }

  if (!story.reddit_id) {
    // Cannot publish through the gate without a source link; leave it for a
    // human rather than failing forever.
    await logSchedulerDecision(
      { storyId: story.id, decision: "auto_held", ...decisionSignals },
      nowMs,
    );
    return { outcome: "held", tripped: false };
  }

  try {
    const published = await publishStoryIfReady(story.reddit_id);
    if (!published.ok) {
      if (published.missing?.includes("already_published")) {
        return { outcome: "skipped", tripped: false }; // an overlapping tick won the race; benign
      }
      // A gate refusal is a per-story content/asset problem, not a systemic
      // publish failure — it never feeds the breaker. Defer a few ticks so
      // in-flight asset backfill can land, then hold the story for a human,
      // which also removes it from the candidate set.
      const refusals = (await countGateRefusals(story.id)) + 1;
      await logSchedulerDecision(
        { storyId: story.id, decision: "auto_gate_refused", ...decisionSignals },
        nowMs,
      );
      const holdNow = refusals >= gateRefusalHoldAfter;
      if (holdNow) {
        await logSchedulerDecision(
          { storyId: story.id, decision: "auto_held", ...decisionSignals },
          nowMs,
        );
      }
      console.warn(`[${logLabel} approve] publish gate refused`, {
        story_id: story.id,
        reason: published.reason,
        missing: published.missing ?? [],
        attempt: refusals,
        held: holdNow,
      });
      return { outcome: holdNow ? "held" : "deferred", tripped: false };
    }

    const scheduled = await scheduleStoryPublish(story.id, {
      approvedBy: decidedBy,
    });
    await breaker.resetFailures();
    await logSchedulerDecision(
      { storyId: story.id, decision: "auto_approved", ...decisionSignals },
      nowMs,
    );
    console.info(`[${logLabel} approve] published`, {
      story_id: story.id,
      publishEnabled: scheduled.publishEnabled,
      scheduled: scheduled.scheduled,
      outcomes: scheduled.outcomes.map((o) => `${o.platform}:${o.status}`),
    });
    // The story is live on the site; zero queued social posts means the
    // master switch is off, every platform is disabled, or every slot
    // horizon is full. An admin expecting "auto upload to socials" got
    // nothing — say why.
    if (scheduled.scheduled === 0) {
      console.warn(`[${logLabel} approve] story published but ZERO social posts queued`, {
        story_id: story.id,
        publish_enabled: scheduled.publishEnabled,
        outcomes: scheduled.outcomes.map((o) => `${o.platform}:${o.status}`),
      });
    }
    return { outcome: "approved", tripped: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${logLabel} approve] publish threw`, {
      story_id: story.id,
      err: msg.slice(0, 300),
    });
    const tripped = await breaker.recordFailure(story.id, msg, nowMs);
    return { outcome: "failed", tripped };
  }
}
