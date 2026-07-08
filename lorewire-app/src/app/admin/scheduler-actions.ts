"use server";

// Server actions for the scheduler admin surface: the human approval gate
// (approve / reject a reviewed story) and the per-platform publish toggle
// (which auto-disables the legacy instant-publish toggle to prevent
// double-posting).
//
// Approve reuses publishStoryIfReady (the shared gate that flips a story
// review -> published, autocurates, and revalidates) and then queues the
// social posts through the Publish Scheduler. It deliberately does NOT
// post to socials inline; the dispatch cron fires each platform at its
// scheduled slot.
//
// Plan: _plans/2026-07-01-render-and-publish-schedulers.md.

import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/dal";
import { getStory, setStatus, setSetting } from "@/lib/repo";
import { getRedditSource } from "@/lib/reddit-source";
import { publishStoryIfReady } from "@/lib/auto-publish";
import {
  AUTOPILOT_SETTING_KEYS,
  resetAutopilotFailures,
  type AutopilotMode,
} from "@/lib/autopilot";
import { retractStory, type RetractResult } from "@/lib/retract-story";
import {
  PUBLISH_PLATFORMS,
  cancelScheduledPublish,
  logSchedulerDecision,
  platformSettingKey,
  scheduleStoryPublish,
  scheduleStoryPublishAt,
  type ExplicitScheduleResult,
  type PlatformScheduleOutcome,
  type PublishPlatform,
} from "@/lib/publish-scheduler";

// Hours a story has sat since its last touch, used as the review-age
// signal on the decision log. Not exported (only async actions may be).
function ageHoursSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / 3_600_000);
}

interface ApproveResult {
  ok: boolean;
  error?: string;
  missing?: string[];
  publishEnabled?: boolean;
  scheduled?: number;
  outcomes?: PlatformScheduleOutcome[];
}

/**
 * Approve a reviewed story: run the publish gate, flip it to published,
 * and queue its social posts across every enabled platform at their next
 * open slots. The story leaves the review queue immediately; the posts
 * go out on schedule.
 */
export async function schedulerApproveStoryAction(
  storyId: string,
): Promise<ApproveResult> {
  const session = await requireCapability("content.manage");
  if (!storyId) return { ok: false, error: "missing story id" };

  const story = await getStory(storyId);
  if (!story) return { ok: false, error: "story_not_found" };
  if (!story.reddit_id) {
    return {
      ok: false,
      error: "not a Reddit-origin story; publish it from the normal flow",
    };
  }

  // Gate + flip review -> published + autocurate + revalidate. Reuses the
  // exact path the auto-publish cron and manual review-publish use, so an
  // asset-incomplete story cannot be approved onto the public site.
  const published = await publishStoryIfReady(story.reddit_id);
  if (!published.ok) {
    return {
      ok: false,
      error: published.reason,
      missing: published.reason === "not_ready" ? published.missing : undefined,
    };
  }

  // Queue the social posts. Idempotent per (story, platform).
  const scheduled = await scheduleStoryPublish(storyId, {
    approvedBy: session.userId,
  });

  const source = await getRedditSource(story.reddit_id);
  await logSchedulerDecision({
    storyId,
    redditId: story.reddit_id,
    decision: "approved",
    tier: source?.strength ?? null,
    comments: source?.comments ?? null,
    subreddit: source?.subreddit ?? null,
    ageHours: ageHoursSince(story.updated_at),
    decidedBy: session.userId,
  });

  console.info("[scheduler approve]", {
    storyId,
    actorId: session.userId,
    publishEnabled: scheduled.publishEnabled,
    scheduled: scheduled.scheduled,
  });

  revalidatePath("/admin/scheduler");
  revalidatePath(`/admin/stories/${storyId}`);
  revalidatePath("/admin");
  return {
    ok: true,
    publishEnabled: scheduled.publishEnabled,
    scheduled: scheduled.scheduled,
    outcomes: scheduled.outcomes,
  };
}

/**
 * Reject a reviewed story: send it back to draft (re-editable) and record
 * the verdict. Never publishes or schedules anything.
 */
export async function schedulerRejectStoryAction(
  storyId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await requireCapability("content.manage");
  if (!storyId) return { ok: false, error: "missing story id" };

  const story = await getStory(storyId);
  if (!story) return { ok: false, error: "story_not_found" };

  await setStatus(storyId, "draft");

  const source = story.reddit_id ? await getRedditSource(story.reddit_id) : null;
  await logSchedulerDecision({
    storyId,
    redditId: story.reddit_id ?? null,
    decision: "rejected",
    tier: source?.strength ?? null,
    comments: source?.comments ?? null,
    subreddit: source?.subreddit ?? null,
    ageHours: ageHoursSince(story.updated_at),
    decidedBy: session.userId,
  });

  console.info("[scheduler reject]", { storyId, actorId: session.userId });
  revalidatePath("/admin/scheduler");
  revalidatePath(`/admin/stories/${storyId}`);
  return { ok: true };
}

export interface ScheduleAtPlatformResult {
  platform: string;
  status: ExplicitScheduleResult["status"];
  scheduledForIso?: string;
  capExceeded?: boolean;
}

interface ScheduleAtResult {
  ok: boolean;
  error?: string;
  /** Per-platform outcome, in the order requested. */
  results?: ScheduleAtPlatformResult[];
}

/**
 * Queue one story to post at an explicit date/time on one or more
 * platforms, entered as each platform's local wall clock
 * ("YYYY-MM-DDTHH:MM" from a datetime-local input). Bypasses
 * next-open-slot math; still one active row per (story, platform), and
 * each platform reports its own outcome.
 */
export async function schedulerScheduleAtAction(input: {
  storyId: string;
  platforms: string[];
  whenLocal: string;
}): Promise<ScheduleAtResult> {
  const session = await requireCapability("content.manage");
  const { storyId, platforms, whenLocal } = input;
  if (!storyId) return { ok: false, error: "missing story id" };
  if (!Array.isArray(platforms) || platforms.length === 0) {
    return { ok: false, error: "pick at least one platform" };
  }
  for (const platform of platforms) {
    if (!(PUBLISH_PLATFORMS as readonly string[]).includes(platform)) {
      return { ok: false, error: "unknown platform" };
    }
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(whenLocal ?? "");
  if (!m) return { ok: false, error: "pick a date and time" };
  const when = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  };

  const story = await getStory(storyId);
  if (!story) return { ok: false, error: "story_not_found" };

  const results: ScheduleAtPlatformResult[] = [];
  for (const platform of platforms) {
    const result = await scheduleStoryPublishAt(
      storyId,
      platform as PublishPlatform,
      when,
      { approvedBy: session.userId },
    );
    results.push({
      platform,
      status: result.status,
      scheduledForIso: result.scheduledForIso,
      capExceeded: result.capExceeded,
    });
  }

  console.info("[scheduler schedule_at]", {
    storyId,
    whenLocal,
    actorId: session.userId,
    results: results.map((r) => `${r.platform}:${r.status}`),
  });

  if (results.some((r) => r.status === "scheduled")) {
    revalidatePath("/admin/scheduler");
  }
  return { ok: true, results };
}

/**
 * Cancel a queued post before the dispatcher claims it. Rows already
 * publishing or posted stay put.
 */
export async function schedulerCancelPublishAction(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await requireCapability("content.manage");
  if (!id) return { ok: false, error: "missing id" };

  const cancelled = await cancelScheduledPublish(id);
  console.info("[scheduler cancel]", { id, actorId: session.userId, cancelled });
  if (!cancelled) {
    return { ok: false, error: "too late — this post already went out or is publishing" };
  }
  revalidatePath("/admin/scheduler");
  return { ok: true };
}

/**
 * Recall a story everywhere: cancel queued posts, pull it off the site,
 * delete the platform posts that APIs allow deleting (TikTok reports
 * back for manual removal). Destructive; the UI confirms before calling.
 */
export async function schedulerRetractStoryAction(
  storyId: string,
): Promise<RetractResult> {
  const session = await requireCapability("content.manage");
  if (!storyId) {
    return {
      ok: false,
      error: "missing story id",
      cancelledQueued: 0,
      archived: false,
      platforms: [],
    };
  }
  const result = await retractStory(storyId);
  console.info("[scheduler retract]", {
    storyId,
    actorId: session.userId,
    ok: result.ok,
    cancelledQueued: result.cancelledQueued,
    archived: result.archived,
    platforms: result.platforms.map((p) => `${p.platform}:${p.status}`),
  });
  revalidatePath("/admin/scheduler");
  revalidatePath(`/admin/stories/${storyId}`);
  return result;
}

/**
 * Switch autopilot between off / shadow / live / autonomous. Any
 * deliberate mode change also resets the circuit breaker (failure counter
 * + trip stamp): an admin turning it back on has seen the trip banner and
 * is making a fresh start, not resuming a failing run.
 */
export async function setAutopilotModeAction(
  mode: AutopilotMode,
): Promise<{ ok: boolean; error?: string }> {
  const session = await requireCapability("settings.manage");
  if (
    mode !== "off" &&
    mode !== "shadow" &&
    mode !== "live" &&
    mode !== "autonomous"
  ) {
    return { ok: false, error: "unknown mode" };
  }
  await setSetting(AUTOPILOT_SETTING_KEYS.mode, mode);
  await resetAutopilotFailures();
  await setSetting(AUTOPILOT_SETTING_KEYS.trippedAt, "");
  console.info("[scheduler autopilot_mode]", { mode, actorId: session.userId });
  revalidatePath("/admin/scheduler");
  return { ok: true };
}

/**
 * Turn the Publish Scheduler on/off for one platform. Enabling it also
 * switches OFF that platform's legacy instant-publish toggle
 * (publisher.<platform>.auto_publish), because the scheduler and the
 * render-time auto-publish must not both fire or the same short posts
 * twice. This is the "auto-disable legacy toggle" the admin chose.
 */
export async function setPlatformSchedulerEnabledAction(
  platform: PublishPlatform,
  enabled: boolean,
): Promise<{ ok: boolean }> {
  await requireCapability("settings.manage");
  await setSetting(platformSettingKey(platform, "enabled"), enabled ? "1" : "0");
  if (enabled) {
    await setSetting(`publisher.${platform}.auto_publish`, "0");
  }
  revalidatePath("/admin/scheduler");
  return { ok: true };
}
