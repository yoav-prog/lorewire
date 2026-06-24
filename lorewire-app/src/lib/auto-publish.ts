// 2026-06-24 Full Pipeline auto-publish helper.
//
// The Python worker writes story_jobs.auto_publish_status='pending' when
// a Full-Pipeline-opted source finishes every stage successfully (see
// pipeline/story_jobs_worker.py + pipeline/store.py::request_story_job_
// auto_publish). The Vercel cron at /api/auto_publish_full_pipeline reads
// pending rows and calls publishStoryIfReady() here per row.
//
// The helper runs the SAME readiness gate (evaluatePublishReadiness) that
// the admin's manual publishReviewedStoryAction uses, so a row that would
// be rejected by the human-click path also gets rejected by the cron. The
// admin path stays the canonical UI surface; this helper is the cron's
// drop-in equivalent (no FormData, no redirect, no revalidatePath that
// needs a Next.js render context — those are handled by the route caller
// because revalidatePath is safe to call from a route handler).
//
// Plan: _plans/2026-06-24-reddit-source-full-pipeline-toggle.md.

import "server-only";
import { revalidatePath } from "next/cache";
import { getStory, setStatus } from "@/lib/repo";
import { getRedditSource, evaluatePublishReadiness } from "@/lib/reddit-source";
import { autoCurateOnPublish } from "@/lib/publish-auto-curate";

export type PublishStoryResult =
  | { ok: true; storyId: string }
  | { ok: false; reason: "source_not_found" | "story_not_found" | "not_ready"; missing?: string[] };

/** Run the publish gate for a reddit source and, if ready, flip the
 *  linked story to status='published' + autocurate + revalidate the
 *  surfaces that show it. Pure return shape (no redirect, no throw on
 *  the not-ready path) so the cron drain can branch on the result.
 *
 *  Idempotent: a story that's already published comes back as
 *  not_ready with missing=["story is already published"] — same
 *  message the human-click path surfaces, so the drain logs it as
 *  failed and stops retrying (single attempt per pending row). */
export async function publishStoryIfReady(
  redditId: string,
): Promise<PublishStoryResult> {
  const source = await getRedditSource(redditId);
  if (!source) {
    return { ok: false, reason: "source_not_found" };
  }
  const story = source.story_id ? await getStory(source.story_id) : null;
  const readiness = evaluatePublishReadiness(story, {
    status: source.status,
    story_id: source.story_id,
  });
  if (!readiness.ready) {
    return { ok: false, reason: "not_ready", missing: readiness.missing };
  }

  await setStatus(story!.id, "published");
  // Auto-curate AFTER the status flip so a curation failure can't
  // unpublish. The helper swallows its own errors. Mirrors the order in
  // publishReviewedStoryAction so the manual + auto paths surface the
  // story on the homepage at the same point in the publish flow.
  await autoCurateOnPublish(story!.id, story!.category);
  // Revalidate the surfaces that show this story so the public site
  // serves the new state on first hit. Same set publishReviewedStoryAction
  // hits, minus the per-row admin review redirect (the cron doesn't
  // render that page so it doesn't need to revalidate it tightly).
  revalidatePath(`/admin/reddit-sources/${redditId}`);
  revalidatePath("/admin/reddit-sources");
  revalidatePath(`/admin/stories/${story!.id}`);
  revalidatePath("/admin");
  revalidatePath("/");
  return { ok: true, storyId: story!.id };
}
