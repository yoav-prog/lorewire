// 2026-06-24 Full Pipeline auto-publish helper.
//
// The Python worker writes story_jobs.auto_publish_status='pending' when
// a Full-Pipeline-opted source finishes every stage successfully (see
// pipeline/story_jobs_worker.py + pipeline/store.py::request_story_job_
// auto_publish). The Vercel cron at /api/auto_publish_full_pipeline reads
// pending rows and calls publishStoryIfReady() here per row.
//
// 2026-06-25 (gate-unification follow-up to #101): this helper now runs
// the SAME evaluateAssetCompleteness gate the manual review-publish and
// bulk Publish paths use, so the Full-Pipeline cron can no longer slip
// an asset-incomplete story to the public site. Last legacy publish
// path to be tightened — closes the gap THE STOVETOP MYSTERY exposed.
//
// Self-heal for the common transient miss: when "poll" is the ONLY
// missing gate, retry autoDraftPollForSubject inline. The poll
// autodraft on save sometimes loses to the publish-cron race; a
// single retry here turns "publish failed" into "publish succeeded"
// for the dominant transient case without touching any other path.
//
// Plan: _plans/2026-06-24-reddit-source-full-pipeline-toggle.md +
// _plans/2026-06-25-bulk-complete-and-publish.md follow-up.

import "server-only";
import { revalidatePath } from "next/cache";
import { getStory, setStatus } from "@/lib/repo";
import { getRedditSource } from "@/lib/reddit-source";
import { evaluateAssetCompleteness } from "@/lib/asset-completeness";
import { autoCurateOnPublish } from "@/lib/publish-auto-curate";
import { autoDraftPollForSubject } from "@/lib/poll-autodraft";

export type PublishStoryResult =
  | { ok: true; storyId: string }
  | { ok: false; reason: "source_not_found" | "story_not_found" | "not_ready"; missing?: string[] };

/** Run the publish gate for a reddit source and, if ready, flip the
 *  linked story to status='published' + autocurate + revalidate the
 *  surfaces that show it. Pure return shape (no redirect, no throw on
 *  the not-ready path) so the cron drain can branch on the result.
 *
 *  Idempotent: a story that's already published comes back as
 *  not_ready with missing=["already_published"] — same shape the
 *  bulk action surfaces, so the drain logs it as failed and stops
 *  retrying (single attempt per pending row). */
export async function publishStoryIfReady(
  redditId: string,
): Promise<PublishStoryResult> {
  const source = await getRedditSource(redditId);
  if (!source) {
    return { ok: false, reason: "source_not_found" };
  }
  if (!source.story_id) {
    return { ok: false, reason: "story_not_found" };
  }
  const story = await getStory(source.story_id);
  if (!story) {
    return { ok: false, reason: "story_not_found" };
  }

  let completeness = await evaluateAssetCompleteness(story.id);

  // Self-heal for the dominant transient: if "poll" is the ONLY
  // missing gate, retry autodraft and re-evaluate once. Same trick
  // the /api/auto_complete_publish cron uses — composes the
  // existing "enabled=0 + LLM OK → upgrade to enabled=1" path in
  // poll-autodraft. Other missing gates (thumbnails, short,
  // voiceover, etc.) need real asset work and should be fixed via
  // the Complete & publish bulk action; we don't try to fix them
  // from here.
  if (
    !completeness.ready &&
    completeness.missing.length === 1 &&
    completeness.missing[0] === "poll"
  ) {
    try {
      await autoDraftPollForSubject({
        kind: "story",
        storyId: story.id,
        title: story.title,
        body: story.body,
        category: story.category,
      });
      completeness = await evaluateAssetCompleteness(story.id);
    } catch {
      // Autodraft itself failed; fall through to the not_ready branch
      // with the original missing list. The next cron tick won't
      // re-attempt (this helper runs once per pending row).
    }
  }

  if (!completeness.ready) {
    return {
      ok: false,
      reason: "not_ready",
      missing: completeness.missing,
    };
  }

  await setStatus(story.id, "published");
  // Auto-curate AFTER the status flip so a curation failure can't
  // unpublish. The helper swallows its own errors. Mirrors the order in
  // publishReviewedStoryAction so the manual + auto paths surface the
  // story on the homepage at the same point in the publish flow.
  await autoCurateOnPublish(story.id, story.category);
  // Revalidate the surfaces that show this story so the public site
  // serves the new state on first hit. Same set publishReviewedStoryAction
  // hits, minus the per-row admin review redirect (the cron doesn't
  // render that page so it doesn't need to revalidate it tightly).
  revalidatePath(`/admin/reddit-sources/${redditId}`);
  revalidatePath("/admin/reddit-sources");
  revalidatePath(`/admin/stories/${story.id}`);
  revalidatePath("/admin");
  revalidatePath("/");
  return { ok: true, storyId: story.id };
}
