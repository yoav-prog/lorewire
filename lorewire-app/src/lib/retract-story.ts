// Retract: the recall path for a story that should not have gone out.
//
// Every other safeguard (kill switches, shadow mode, the safety judge,
// the circuit breaker) prevents the NEXT bad publish; this is the only
// thing that recalls one that is already live. One call: cancel the
// social posts still waiting to fire, pull the story off the site, and
// delete the posts that already went out on every platform whose API
// allows it. TikTok's Content Posting API has no delete endpoint, so a
// posted TikTok is reported back for manual removal in the app.
//
// Rows the dispatcher has claimed this very minute (state='publishing')
// cannot be stopped mid-flight; they surface as posted rows on the next
// retract attempt.
//
// Plan: _plans/2026-07-02-scheduler-autopilot-and-flexible-slots.md.

import "server-only";

import { revalidatePath } from "next/cache";
import { all, run } from "@/lib/db";
import { getStory, setStatus } from "@/lib/repo";
import { deleteLatestPostedRowForStory as deleteYouTubePost } from "@/lib/publish-to-youtube";
import { deleteLatestPostedRowForStory as deleteFacebookPostRow } from "@/lib/publish-to-facebook";
import { deleteLatestPostedRowForStory as deleteInstagramPostRow } from "@/lib/publish-to-instagram";
import { deleteLatestPostedRowForStory as deleteTikTokPostRow } from "@/lib/publish-to-tiktok";

export type RetractPlatformStatus =
  | "deleted"
  | "manual_delete_needed"
  | "nothing_posted"
  | "failed";

export interface RetractPlatformOutcome {
  platform: "youtube" | "facebook" | "instagram" | "tiktok";
  status: RetractPlatformStatus;
  detail: string | null;
}

export interface RetractResult {
  ok: boolean;
  error?: string;
  /** Queued (not yet fired) social posts cancelled. */
  cancelledQueued: number;
  /** True when the story itself was pulled off the site. */
  archived: boolean;
  platforms: RetractPlatformOutcome[];
}

const NO_POSTED_ROW = "no posted row found for story";

function log(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[retract ${event}]`, JSON.stringify(fields));
}

/**
 * Recall one story everywhere. Steps are ordered by blast radius:
 * cancel future posts first (cheap, reversible damage stops here), then
 * unpublish the site, then delete what already went out. Platform
 * failures do not abort the rest — each platform reports its own
 * outcome and a retry of the whole action is safe (idempotent per
 * step).
 */
export async function retractStory(storyId: string): Promise<RetractResult> {
  const story = await getStory(storyId);
  if (!story) {
    return {
      ok: false,
      error: "story_not_found",
      cancelledQueued: 0,
      archived: false,
      platforms: [],
    };
  }

  // 1. Cancel everything still waiting to fire.
  const queued = await all<{ id: string }>(
    "SELECT id FROM scheduled_publishes WHERE story_id = ? AND state = 'scheduled'",
    [storyId],
  );
  if (queued.length > 0) {
    await run(
      "UPDATE scheduled_publishes SET state = 'cancelled' WHERE story_id = ? AND state = 'scheduled'",
      [storyId],
    );
  }

  // 2. Pull the story off the site.
  const archived = story.status === "published";
  await setStatus(storyId, "archived");
  revalidatePath("/");
  revalidatePath(`/admin/stories/${storyId}`);
  revalidatePath("/admin");

  // 3. Delete what already went out, platform by platform.
  const platforms: RetractPlatformOutcome[] = [];

  const yt = await deleteYouTubePost(storyId);
  platforms.push(
    yt.ok
      ? { platform: "youtube", status: "deleted", detail: null }
      : {
          platform: "youtube",
          status: yt.error === NO_POSTED_ROW ? "nothing_posted" : "failed",
          detail: yt.error === NO_POSTED_ROW ? null : yt.error,
        },
  );

  const fb = await deleteFacebookPostRow(storyId);
  platforms.push(
    fb.ok
      ? { platform: "facebook", status: "deleted", detail: null }
      : {
          platform: "facebook",
          status: fb.error === NO_POSTED_ROW ? "nothing_posted" : "failed",
          detail: fb.error === NO_POSTED_ROW ? null : fb.error,
        },
  );

  const ig = await deleteInstagramPostRow(storyId);
  platforms.push(
    ig.ok
      ? { platform: "instagram", status: "deleted", detail: null }
      : {
          platform: "instagram",
          status: ig.error === NO_POSTED_ROW ? "nothing_posted" : "failed",
          detail: ig.error === NO_POSTED_ROW ? null : ig.error,
        },
  );

  // TikTok has no delete API: a success here only cleared the local row.
  const tt = await deleteTikTokPostRow(storyId);
  platforms.push(
    tt.ok
      ? {
          platform: "tiktok",
          status: "manual_delete_needed",
          detail: "TikTok's API cannot delete posts — remove it in the TikTok app.",
        }
      : {
          platform: "tiktok",
          status: tt.error === NO_POSTED_ROW ? "nothing_posted" : "failed",
          detail: tt.error === NO_POSTED_ROW ? null : tt.error,
        },
  );

  log("done", {
    story_id: storyId,
    cancelled_queued: queued.length,
    archived,
    platforms: platforms.map((p) => `${p.platform}:${p.status}`),
  });

  return { ok: true, cancelledQueued: queued.length, archived, platforms };
}
