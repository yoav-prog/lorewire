// Asset readiness gate for the bulk complete-and-publish flow.
//
// Single source of truth for "does this video story have everything it
// needs before the cron is allowed to publish it." Composes:
//
//   1. evaluatePublishReadiness() — body, hero, status-not-already-
//      published. Reused so this gate stays in lock-step with the
//      manual publish path (publishReviewedStoryAction) and the Full-
//      Pipeline auto-publish cron (auto-publish.ts).
//
//   2. Per-platform thumbnail variants — five columns on stories
//      written by the Python pipeline's hero/thumbnail finisher
//      (pipeline/media.py::_HERO_THUMB_VARIANTS): hero_image (3:4),
//      hero_image_landscape (16:9), thumbnail_image (3:4),
//      thumbnail_image_landscape (16:9), thumbnail_image_square (1:1).
//      All five are produced as one atomic job; checking each
//      separately lets the cron log exactly which one a partial
//      failure dropped.
//
//   3. Short render — a short_renders row with status='done' AND
//      output_url. Same gate latestDoneShortRenderForStory uses.
//
//   4. Voiceover + every scene image — these are the inputs to the
//      short render, so a successful short implies both are present.
//      We still check them explicitly so an operator looking at a
//      stuck story sees the precise broken link instead of
//      "short render missing" without context.
//
//   5. Poll attached — polls row matching story_id with enabled=1
//      and a non-blank question. Per-product rule: a video story
//      without a poll does not publish.
//
// Returns the same shape as evaluatePublishReadiness so callers can
// branch on { ready, missing } uniformly. The `details` field is
// for the cron's structured log output — every gate reports its
// state independently so a partial failure tells us what to re-
// enqueue.
//
// Plan: _plans/2026-06-25-bulk-complete-and-publish.md.

import "server-only";
import { one } from "@/lib/db";
import { getStory } from "@/lib/repo";
import {
  evaluatePublishReadiness,
  getRedditSource,
  type PublishReadiness,
} from "@/lib/reddit-source";
import { getPollByStoryId } from "@/lib/polls";
import { latestDoneShortRenderForStory } from "@/lib/short-render-queue";
import { parseShortConfig } from "@/lib/short-config";

// ─── Public surface ───────────────────────────────────────────────────────────

/** Closed set of asset gates. The strings are stable — the cron logs
 *  them as `missing` so changing one is a breaking change for any
 *  observability that greps them. */
export type AssetGate =
  | "body"
  | "hero_image"
  | "hero_image_landscape"
  | "thumbnail_image"
  | "thumbnail_image_landscape"
  | "thumbnail_image_square"
  | "short_render"
  | "voiceover"
  | "scene_images"
  | "poll"
  | "already_published"
  | "story_missing"
  | "wrong_kind";

export interface AssetCompleteness {
  ready: boolean;
  /** Stable codes the cron logs + the action surfaces in toasts. */
  missing: AssetGate[];
  /** Free-form per-gate detail for the structured log. The cron writes
   *  this verbatim; the action surfaces `missing` only. */
  details: {
    body_present: boolean;
    hero_image_present: boolean;
    hero_image_landscape_present: boolean;
    thumbnail_image_present: boolean;
    thumbnail_image_landscape_present: boolean;
    thumbnail_image_square_present: boolean;
    short_render_present: boolean;
    voiceover_present: boolean;
    scenes_with_url: number;
    scenes_total: number;
    poll_present_and_enabled: boolean;
    story_status: string | null;
  };
}

/** Run the full asset gate for a video story.
 *
 *  Returns `ready: true` only when every required asset exists. The
 *  manual publish gate (evaluatePublishReadiness) is composed in
 *  first, so a story that the manual path rejects also fails here
 *  with the same reasons mapped onto the closed AssetGate set.
 *
 *  Idempotent + side-effect-free. The cron calls it on every tick;
 *  the bulk action calls it before deciding what to enqueue. */
export async function evaluateAssetCompleteness(
  storyId: string,
): Promise<AssetCompleteness> {
  const story = await getStory(storyId);
  if (!story) {
    return emptyDetails({
      ready: false,
      missing: ["story_missing"],
    });
  }

  // The publish-readiness gate also wants the reddit_source status.
  // For stories that didn't come from reddit (manual seeds), the
  // source is null and the gate would reject them on
  // "source row hasn't finished processing". The bulk action filters
  // articles out before this is called, but reddit-less stories DO
  // exist; treat a missing source as a permissive "imported" so the
  // rest of the asset gate carries the verdict. The bulk action
  // refuses non-video kinds before reaching here, so the only
  // reddit-less path is a manual video-story seed.
  const source = story.reddit_id
    ? await getRedditSource(story.reddit_id)
    : null;
  const baseReadiness: PublishReadiness = evaluatePublishReadiness(
    {
      status: story.status,
      body: story.body,
      hero_image: story.hero_image,
      video_url: story.video_url,
    },
    {
      // Permissive for reddit-less seeds — see note above.
      status: source ? source.status : "used",
      story_id: source ? source.story_id : story.id,
    },
  );

  const missing: AssetGate[] = [];

  // Body + hero come from the manual gate. The other strings it can
  // emit are mapped explicitly so we never surface an unmapped string
  // up to the cron's structured log.
  const baseMessages = new Set(baseReadiness.missing);
  if (baseMessages.has("story body is empty")) missing.push("body");
  if (baseMessages.has("hero image is missing")) missing.push("hero_image");
  if (baseMessages.has("story is already published")) {
    missing.push("already_published");
  }
  // Other base reasons ("source hasn't finished", "story has not been
  // generated yet", "story is archived") are surfaced via story_missing
  // OR already_published OR the cron's own status check — we don't need
  // separate gates for them because the bulk action filters at
  // enqueue time.

  // Per-platform thumbnail variants. These columns are added by the
  // Python pipeline (additive ALTER TABLE) so they may not appear on
  // very old story rows; they read as NULL via the COALESCE-free
  // SELECT and surface as `missing` like any other gate.
  const thumbs = await loadThumbnailColumns(storyId);
  if (!nonEmpty(thumbs.hero_image_landscape)) {
    missing.push("hero_image_landscape");
  }
  if (!nonEmpty(thumbs.thumbnail_image)) {
    missing.push("thumbnail_image");
  }
  if (!nonEmpty(thumbs.thumbnail_image_landscape)) {
    missing.push("thumbnail_image_landscape");
  }
  if (!nonEmpty(thumbs.thumbnail_image_square)) {
    missing.push("thumbnail_image_square");
  }

  // Short render: status='done' AND output_url. Reuses the same
  // helper bulkPublishToSocialsAction uses so the two paths cannot
  // disagree on what "short ready" means.
  const render = await latestDoneShortRenderForStory(storyId);
  const shortRenderPresent =
    !!render && render.status === "done" && !!render.output_url;
  if (!shortRenderPresent) missing.push("short_render");

  // Voiceover: the short carries a voiceover_url in its short_config
  // blob (lib/short-config.ts). A successful short render writes it,
  // so this gate is the implicit consequence of `short_render`. We
  // still check explicitly because the short_renders.props can land
  // before short_config is finalized in rare race conditions, and
  // because the audit log wants the precise broken link.
  const sceneState = parseShortConfigState(story.short_config);
  if (!sceneState.voiceoverPresent) missing.push("voiceover");

  // Scene images: every frame in short_config.doodle_frames must
  // have a non-empty url. Empty doodle_frames array also counts as
  // missing — a video story with zero scenes can't render a short.
  if (
    sceneState.scenesTotal === 0 ||
    sceneState.scenesWithUrl !== sceneState.scenesTotal
  ) {
    missing.push("scene_images");
  }

  // Poll: a row in polls keyed by story_id with enabled=1 and a
  // non-blank question. Disabled drafts count as missing — the cron
  // refuses to publish a video story whose poll isn't live.
  const poll = await getPollByStoryId(storyId);
  const pollReady =
    !!poll &&
    poll.enabled === 1 &&
    typeof poll.question === "string" &&
    poll.question.trim() !== "";
  if (!pollReady) missing.push("poll");

  return {
    ready: missing.length === 0,
    missing,
    details: {
      body_present: !!(story.body && story.body.trim() !== ""),
      hero_image_present: !!story.hero_image,
      hero_image_landscape_present: nonEmpty(thumbs.hero_image_landscape),
      thumbnail_image_present: nonEmpty(thumbs.thumbnail_image),
      thumbnail_image_landscape_present: nonEmpty(
        thumbs.thumbnail_image_landscape,
      ),
      thumbnail_image_square_present: nonEmpty(thumbs.thumbnail_image_square),
      short_render_present: shortRenderPresent,
      voiceover_present: sceneState.voiceoverPresent,
      scenes_with_url: sceneState.scenesWithUrl,
      scenes_total: sceneState.scenesTotal,
      poll_present_and_enabled: pollReady,
      story_status: story.status,
    },
  };
}

// ─── Internals ────────────────────────────────────────────────────────────────

interface ThumbnailColumns {
  hero_image_landscape: string | null;
  thumbnail_image: string | null;
  thumbnail_image_landscape: string | null;
  thumbnail_image_square: string | null;
}

/** Load the four Python-pipeline-added thumbnail variant columns for a
 *  story. Selected directly because StoryRow in repo.ts intentionally
 *  doesn't expose them (they aren't in the canonical TS schema; the
 *  Python pipeline owns them via its own additive migrate). NULL is
 *  the sentinel for "missing" — we don't COALESCE, the caller treats
 *  null/empty-string identically via nonEmpty(). */
async function loadThumbnailColumns(
  storyId: string,
): Promise<ThumbnailColumns> {
  const row = await one<ThumbnailColumns>(
    `SELECT hero_image_landscape, thumbnail_image, thumbnail_image_landscape,
            thumbnail_image_square
     FROM stories WHERE id = ?`,
    [storyId],
  );
  return (
    row ?? {
      hero_image_landscape: null,
      thumbnail_image: null,
      thumbnail_image_landscape: null,
      thumbnail_image_square: null,
    }
  );
}

interface SceneState {
  scenesTotal: number;
  scenesWithUrl: number;
  voiceoverPresent: boolean;
}

/** Walk a story's short_config JSON for the inputs to the short
 *  render (every scene has its image; the voiceover URL is set). Bad
 *  JSON or a missing config maps to "nothing present" — the gate will
 *  surface scene_images + voiceover as missing, which matches the
 *  user-facing reality. */
function parseShortConfigState(rawShortConfig: string | null): SceneState {
  if (!rawShortConfig) {
    return { scenesTotal: 0, scenesWithUrl: 0, voiceoverPresent: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawShortConfig);
  } catch {
    return { scenesTotal: 0, scenesWithUrl: 0, voiceoverPresent: false };
  }
  const result = parseShortConfig(parsed);
  if (!result.ok) {
    return { scenesTotal: 0, scenesWithUrl: 0, voiceoverPresent: false };
  }
  const frames = result.config.doodle_frames;
  const scenesWithUrl = frames.filter((f) => nonEmpty(f.url)).length;
  return {
    scenesTotal: frames.length,
    scenesWithUrl,
    voiceoverPresent: nonEmpty(result.config.voiceover_url),
  };
}

function nonEmpty(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim() !== "";
}

function emptyDetails(
  partial: Pick<AssetCompleteness, "ready" | "missing">,
): AssetCompleteness {
  return {
    ...partial,
    details: {
      body_present: false,
      hero_image_present: false,
      hero_image_landscape_present: false,
      thumbnail_image_present: false,
      thumbnail_image_landscape_present: false,
      thumbnail_image_square_present: false,
      short_render_present: false,
      voiceover_present: false,
      scenes_with_url: 0,
      scenes_total: 0,
      poll_present_and_enabled: false,
      story_status: null,
    },
  };
}
