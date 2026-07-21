// Shared "publish this story's short to one platform" helper.
//
// The render post-hook (render_short route) has per-platform *ForRender
// wrappers that build the caption/metadata context and dispatch to the
// publish-to-<platform> functions with trigger 'auto'. The Publish
// Scheduler's dispatcher needs the same context build but with trigger
// 'scheduled'. This module is the shared piece so the two callers agree
// on how context is constructed, and normalizes the four publishers'
// slightly different result shapes into one outcome the dispatcher can
// act on.
//
// Plan: _plans/2026-07-01-render-and-publish-schedulers.md.

import "server-only";
import { one } from "@/lib/db";
import { getStory } from "@/lib/repo";
import { publishShortToFacebook } from "@/lib/publish-to-facebook";
import { publishShortToInstagram } from "@/lib/publish-to-instagram";
import { publishShortToTikTok } from "@/lib/publish-to-tiktok";
import { publishShortToYouTube } from "@/lib/publish-to-youtube";
import type { PublishPlatform } from "@/lib/publish-scheduler";

/** Latest published article URL for a story, falling back to the site
 *  origin so the caption renderer always has an {{article_url}}. Mirrors
 *  the inline helper in the render_short route. */
export async function resolveArticleUrlForStory(storyId: string): Promise<string> {
  const origin =
    process.env.NEXT_PUBLIC_SITE_ORIGIN || "https://www.lorewire.com";
  const article = await one<{ language: string; slug: string }>(
    "SELECT language, slug FROM articles WHERE story_id = ? AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1",
    [storyId],
  ).catch(() => null);
  return article ? `${origin}/articles/${article.language}/${article.slug}` : origin;
}

/** One normalized outcome across the four publishers. `pending` means the
 *  platform accepted an async job (IG/TikTok) that the platform's own
 *  retry cron will finish; from the scheduler's view that is a success. */
export interface NormalizedPublishOutcome {
  status: "posted" | "pending" | "failed" | "skipped";
  externalId: string | null;
  error: string | null;
}

export interface PublishStoryArgs {
  storyId: string;
  renderId: string | null;
  videoUrl: string;
  trigger: "auto" | "manual" | "scheduled";
}

/**
 * Publish a story's rendered short to one platform, building the same
 * caption/metadata context the render hook uses. Returns a normalized
 * outcome. YouTube and TikTok get the category token; Facebook and
 * Instagram do not (their caption templates do not use it).
 */
export async function publishStoryToPlatform(
  platform: PublishPlatform,
  args: PublishStoryArgs,
): Promise<NormalizedPublishOutcome> {
  const story = await getStory(args.storyId);
  const articleUrl = await resolveArticleUrlForStory(args.storyId);
  const baseContext = {
    hook: null,
    title: story?.title ?? null,
    article_url: articleUrl,
  };
  const shared = {
    storyId: args.storyId,
    renderId: args.renderId ?? null,
    videoUrl: args.videoUrl,
    trigger: args.trigger,
  };

  switch (platform) {
    case "youtube":
      return normalize(
        await publishShortToYouTube({
          ...shared,
          context: { ...baseContext, category: story?.category ?? null },
        }),
      );
    case "tiktok":
      return normalize(
        await publishShortToTikTok({
          ...shared,
          context: { ...baseContext, category: story?.category ?? null },
        }),
      );
    case "facebook":
      return normalize(await publishShortToFacebook({ ...shared, context: baseContext }));
    case "instagram":
      return normalize(await publishShortToInstagram({ ...shared, context: baseContext }));
  }
}

// The four PublishResult unions all share { status } and carry either a
// `row` (posted/pending/failed) or a `reason` (skipped). Row external ids
// differ by column name (external_video_id on YouTube, external_post_id
// elsewhere); read whichever is present.
// Param typed loosely (row?: unknown) so all four publishers' nominally
// distinct PublishResult unions assign to it; the row shape is narrowed
// back inside.
function normalize(result: {
  status: string;
  reason?: string;
  row?: unknown;
}): NormalizedPublishOutcome {
  if (result.status === "skipped") {
    return { status: "skipped", externalId: null, error: result.reason ?? null };
  }
  const row = (result.row ?? {}) as Record<string, unknown>;
  const externalId =
    (row.external_video_id as string | undefined) ??
    (row.external_post_id as string | undefined) ??
    null;
  const error = (row.error_message as string | undefined) ?? null;
  return {
    status: result.status as "posted" | "pending" | "failed",
    externalId,
    error,
  };
}
