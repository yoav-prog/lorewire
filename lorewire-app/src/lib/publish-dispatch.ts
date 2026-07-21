// Publish Scheduler dispatcher: fire the scheduled posts that are due.
//
// The per-minute cron calls dispatchDuePublishes. It picks scheduled_
// publishes rows whose scheduled_for has passed, claims each by flipping
// 'scheduled' -> 'publishing', resolves the story's rendered short URL,
// and hands off to the existing publish-to-<platform> function with
// trigger 'scheduled'. On success the row goes to 'published'; a platform
// failure goes to 'failed' (the platform's own retry cron then owns any
// retry of the *_posts row it created); a skip (already posted / dedup)
// goes to 'cancelled'.
//
// Idempotency: the claim UPDATE is guarded on state='scheduled' and every
// terminal UPDATE on state='publishing', so if two overlapping cron runs
// grab the same row only one terminal write lands. The publisher's own
// story-level dedup is the deeper backstop: even a double dispatch cannot
// double-post, because the second call sees the first's *_posts row and
// skips.
//
// Plan: _plans/2026-07-01-render-and-publish-schedulers.md.

import "server-only";
import { all, one, run } from "@/lib/db";
import { getPublishEnabled } from "@/lib/publish-scheduler";
import type { PublishPlatform } from "@/lib/publish-scheduler";
import { publishStoryToPlatform } from "@/lib/publish-for-story";
import {
  isUnattendedPublishingStopped,
  setUnattendedPublishingStopped,
} from "@/lib/approve-reviewed-story";
import { getAutopilotAlertEmail } from "@/lib/autopilot";
import { sendBrevoEmail } from "@/lib/email";

// Posts attempted per cron firing. Publishing is heavier than the retry
// scans (a YouTube upload can take seconds), so this is lower than the
// retry crons' 25. At one firing per minute this still clears 600/hour.
const DISPATCH_BATCH_LIMIT = 10;

interface DueRow {
  id: string;
  story_id: string;
  render_id: string | null;
  platform: PublishPlatform;
}

export interface DispatchResult {
  disabled: boolean;
  /** True when the global emergency stop was engaged, so nothing was fired. */
  stopped: boolean;
  due: number;
  posted: number;
  failed: number;
  skipped: number;
  /** True when this tick auto-engaged the stop after a failure spike. */
  halted: boolean;
}

// Post-publish safety (Phase 4, interim). If posts start failing en masse in a
// short window — an account got restricted, credentials broke, or a platform is
// rejecting everything — keep going is the wrong move: it risks strikes and
// spams failures. This trips the SAME global emergency stop an admin uses,
// which halts the approve lanes AND (below) this dispatcher, and emails the
// alert address. It is a publish-time-failure signal, NOT a post-publish
// takedown detector — that needs per-platform status polling (a follow-up).
const PUBLISH_HALT = {
  /** How far back the failure rate is measured. */
  windowMs: 60 * 60_000,
  /** Need a real cluster before halting, not one transient blip. */
  minFailures: 4,
  /** ...and most recent attempts must be failing, so a few failures amid
   *  many successes do not trip it. */
  failureRatio: 0.6,
} as const;

export interface PublishHaltResult {
  recentFailures: number;
  recentPublished: number;
  halted: boolean;
}

/**
 * Measure the last-hour publish outcomes and, on a failure spike, engage the
 * global unattended-publish stop + alert. No-op when already stopped (that is
 * also the throttle — one alert per halt). Returns what it saw.
 */
export async function maybeHaltOnPublishFailures(
  nowMs: number = Date.now(),
): Promise<PublishHaltResult> {
  if (await isUnattendedPublishingStopped()) {
    return { recentFailures: 0, recentPublished: 0, halted: false };
  }
  const sinceIso = new Date(nowMs - PUBLISH_HALT.windowMs).toISOString();
  const row = await one<{ failed: number | string; published: number | string }>(
    `SELECT
       SUM(CASE WHEN state = 'failed' AND dispatched_at >= ? THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN state = 'published' AND posted_at >= ? THEN 1 ELSE 0 END) AS published
     FROM scheduled_publishes`,
    [sinceIso, sinceIso],
  );
  const recentFailures = Number(row?.failed ?? 0);
  const recentPublished = Number(row?.published ?? 0);
  const total = recentFailures + recentPublished;
  const ratio = total > 0 ? recentFailures / total : 0;
  console.info("[publish halt] window health", {
    recentFailures,
    recentPublished,
    ratio: Number(ratio.toFixed(2)),
  });

  const spike =
    recentFailures >= PUBLISH_HALT.minFailures && ratio >= PUBLISH_HALT.failureRatio;
  if (!spike) return { recentFailures, recentPublished, halted: false };

  await setUnattendedPublishingStopped(true);
  console.error("[publish halt] publish-failure spike — unattended publishing STOPPED", {
    recentFailures,
    recentPublished,
  });
  const alertEmail = await getAutopilotAlertEmail();
  if (alertEmail) {
    const text =
      `Lorewire stopped unattended publishing automatically: ${recentFailures} of the last ` +
      `${total} posts failed in the past hour. An account may be restricted or a platform may ` +
      `be rejecting posts. Check /admin/scheduler — nothing will auto-publish until you resume.`;
    const sent = await sendBrevoEmail({
      to: alertEmail,
      subject: "Lorewire: auto-publishing stopped after a failure spike",
      html: `<p>${text.replace(/\n/g, "<br/>")}</p>`,
      text,
    });
    console.info("[publish halt] alert email", {
      to: alertEmail,
      ok: sent.ok,
      error: sent.error ?? null,
    });
  }
  return { recentFailures, recentPublished, halted: true };
}

/** The rendered short URL for a story: the pinned render if it is done
 *  and has a URL, else the latest done short render for the story. */
async function resolveShortVideoUrl(
  storyId: string,
  renderId: string | null,
): Promise<string | null> {
  if (renderId) {
    const pinned = await one<{ output_url: string | null }>(
      "SELECT output_url FROM short_renders WHERE id = ? AND status = 'done'",
      [renderId],
    );
    if (pinned?.output_url) return pinned.output_url;
  }
  const latest = await one<{ output_url: string | null }>(
    "SELECT output_url FROM short_renders " +
      "WHERE story_id = ? AND status = 'done' AND output_url IS NOT NULL " +
      "ORDER BY requested_at DESC LIMIT 1",
    [storyId],
  );
  return latest?.output_url ?? null;
}

async function markPublished(id: string, externalId: string | null, nowIso: string) {
  await run(
    "UPDATE scheduled_publishes SET state = 'published', external_post_id = ?, posted_at = ? " +
      "WHERE id = ? AND state = 'publishing'",
    [externalId, nowIso, id],
  );
}

async function markFailed(id: string, error: string) {
  await run(
    "UPDATE scheduled_publishes SET state = 'failed', error_message = ?, " +
      "attempts = COALESCE(attempts, 0) + 1 WHERE id = ? AND state = 'publishing'",
    [error.slice(0, 500), id],
  );
}

async function markCancelled(id: string, note: string) {
  await run(
    "UPDATE scheduled_publishes SET state = 'cancelled', error_message = ? " +
      "WHERE id = ? AND state = 'publishing'",
    [note.slice(0, 500), id],
  );
}

/**
 * Fire every scheduled publish that is due (scheduled_for <= now). Safe to
 * call from the per-minute cron. Returns counts for the cron log.
 */
export async function dispatchDuePublishes(
  nowMs: number = Date.now(),
  limit: number = DISPATCH_BATCH_LIMIT,
): Promise<DispatchResult> {
  if (!(await getPublishEnabled())) {
    return { disabled: true, stopped: false, due: 0, posted: 0, failed: 0, skipped: 0, halted: false };
  }
  // Global emergency stop halts the dispatcher too, so a spike (or an admin
  // pressing stop) freezes queued posts, not just new approvals.
  if (await isUnattendedPublishingStopped()) {
    return { disabled: false, stopped: true, due: 0, posted: 0, failed: 0, skipped: 0, halted: false };
  }
  const nowIso = new Date(nowMs).toISOString();
  const due = await all<DueRow>(
    "SELECT id, story_id, render_id, platform FROM scheduled_publishes " +
      "WHERE state = 'scheduled' AND scheduled_for <= ? ORDER BY scheduled_for ASC LIMIT ?",
    [nowIso, limit],
  );

  let posted = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of due) {
    // Claim: only the run that flips scheduled -> publishing owns the row.
    await run(
      "UPDATE scheduled_publishes SET state = 'publishing', dispatched_at = ? " +
        "WHERE id = ? AND state = 'scheduled'",
      [nowIso, row.id],
    );

    const videoUrl = await resolveShortVideoUrl(row.story_id, row.render_id);
    if (!videoUrl) {
      await markFailed(row.id, "no rendered short video URL for story");
      failed += 1;
      continue;
    }

    try {
      const outcome = await publishStoryToPlatform(row.platform, {
        storyId: row.story_id,
        renderId: row.render_id,
        videoUrl,
        trigger: "scheduled",
      });
      if (outcome.status === "posted" || outcome.status === "pending") {
        await markPublished(row.id, outcome.externalId, nowIso);
        posted += 1;
      } else if (outcome.status === "skipped") {
        await markCancelled(row.id, `skipped: ${outcome.error ?? "already handled"}`);
        skipped += 1;
      } else {
        await markFailed(row.id, outcome.error ?? "publish failed");
        failed += 1;
      }
    } catch (e) {
      await markFailed(row.id, e instanceof Error ? e.message : String(e));
      failed += 1;
    }
  }

  // After firing, check the rolling failure rate and auto-halt on a spike.
  const halt = await maybeHaltOnPublishFailures(nowMs);

  return { disabled: false, stopped: false, due: due.length, posted, failed, skipped, halted: halt.halted };
}
