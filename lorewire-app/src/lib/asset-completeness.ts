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
//      A completed short_renders row IS the proof that voiceover +
//      every scene image existed at render time (the renderer can't
//      finish without them). So gates 4 below are SUPPRESSED when
//      this gate passes — we trust the render over the editor blob.
//
//   3b. stories.video_url — the column the public reader actually
//      plays. A done short_renders row proves the video EXISTS in
//      storage; this gate proves the story can PLAY it. The copy from
//      short_renders.output_url onto the story row (pipeline finisher /
//      applyShortToStory) is a separate write that can be missed — on
//      2026-07-02 two stories published with finished renders in GCS
//      but a NULL video_url, shipping a video story with no video.
//      Callers that hit this gate with a done render present should
//      self-heal via applyLatestDoneShortToStory (both publish drains
//      do). Plan: _plans/2026-07-02-never-publish-without-video.md.
//
//   4. Voiceover + every scene image — only checked when the short
//      itself is missing, as informational hints so the operator
//      knows which sub-asset to re-enqueue. Suppressing these when
//      short_render exists prevents false-negative gates on rows
//      whose short_config was never seeded by the editor (the field
//      `short_config.voiceover_url` only lands when the short
//      editor first opens; older stories rendered before that have
//      a NULL value even though the audio existed at render time).
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
// Two entry points share one derivation (deriveAssetCompleteness):
// evaluateAssetCompleteness for one story (cron / bulk actions) and
// evaluateAssetCompletenessForStories for a whole Content page (the
// per-row "missing: …" chips).
//
// Plans: _plans/2026-06-25-bulk-complete-and-publish.md,
// _plans/2026-07-21-content-row-publish-blockers.md.

import "server-only";
import { all, one } from "@/lib/db";
import { getStory } from "@/lib/repo";
import { evaluatePublishReadiness } from "@/lib/reddit-source";
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
  | "video_url"
  | "voiceover"
  | "scene_images"
  | "poll"
  | "already_published"
  | "story_missing"
  | "wrong_kind";

// Gates that are reported (and auto-backfilled by the complete-and-
// publish cron via `missing`) but do NOT block publishing. Every one
// has a graceful fallback on its surface: the billboard falls back to
// the portrait hero, the OG card falls back through thumbnail → hero →
// site default, and the square thumbnail is consumed only by the
// Instagram publisher (which fails per-platform, not site-wide).
// 2026-07-04: a single flaky kie call on thumbnail_image_square was
// hard-blocking story publishes (1l23hhc) — a web publish must never
// hinge on an Instagram-only asset.
const ADVISORY_GATES: ReadonlySet<AssetGate> = new Set([
  "hero_image_landscape",
  "thumbnail_image_landscape",
  "thumbnail_image_square",
]);

// The BLOCKING image gates the hero+thumbnail finisher (Python asset
// "hero_thumbnail_from_short") produces. When one of these is why a story
// won't publish, re-running that finisher is the fix — it writes all five
// hero/thumbnail variants atomically, so the advisory landscape/square gates
// heal as a side effect. Shared by the Complete-&-publish action and the
// auto-publish cron so both agree on "this is a hero/thumbnail problem" and
// enqueue the SAME asset (2026-07-19: the old path enqueued plain "hero",
// which never wrote thumbnail_image, so a missing card thumbnail could never
// self-heal). Plan: _plans/2026-07-19-asset-incomplete-thumbnail-heal.md.
export const HERO_THUMBNAIL_BLOCKING_GATES: ReadonlySet<AssetGate> = new Set([
  "hero_image",
  "thumbnail_image",
]);

export interface AssetCompleteness {
  /** True when no BLOCKING gate is missing (advisory gates may be). */
  ready: boolean;
  /** Stable codes the cron logs + the action surfaces in toasts.
   *  Includes advisory gates so the complete-and-publish cron still
   *  re-enqueues them; `blocking` is what `ready` is computed from. */
  missing: AssetGate[];
  /** The subset of `missing` that actually blocks publish. */
  blocking: AssetGate[];
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
    video_url_present: boolean;
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

  // Per-platform thumbnail variants. These columns are added by the
  // Python pipeline (additive ALTER TABLE) so they may not appear on
  // very old story rows; they read as NULL via the COALESCE-free
  // SELECT and surface as `missing` like any other gate.
  const thumbs = await loadThumbnailColumns(storyId);

  // Short render: status='done' AND output_url. Reuses the same
  // helper bulkPublishToSocialsAction uses so the two paths cannot
  // disagree on what "short ready" means.
  const render = await latestDoneShortRenderForStory(storyId);
  const shortRenderPresent =
    !!render && render.status === "done" && !!render.output_url;

  // Poll: a row in polls keyed by story_id with enabled=1 and a
  // non-blank question. Disabled drafts count as missing — the cron
  // refuses to publish a video story whose poll isn't live.
  const poll = await getPollByStoryId(storyId);
  const pollReady =
    !!poll &&
    poll.enabled === 1 &&
    typeof poll.question === "string" &&
    poll.question.trim() !== "";

  return deriveAssetCompleteness({
    storyStatus: story.status,
    bodyPresent: !!(story.body && story.body.trim() !== ""),
    heroImage: story.hero_image,
    videoUrl: story.video_url,
    thumbs,
    shortRenderPresent,
    sceneState: parseShortConfigState(story.short_config),
    pollReady,
  });
}

/** Batched evaluateAssetCompleteness for list surfaces (the Content
 *  inbox row chips). Three IN-list queries for the whole page instead
 *  of ~4 per story, feeding the SAME deriveAssetCompleteness the
 *  single-story path uses so the two can never disagree on what
 *  blocks a publish.
 *
 *  Returns a Map keyed by story id; ids with no stories row are
 *  simply absent (the single path's story_missing early-exit).
 *
 *  One documented divergence, details only: short_config is fetched
 *  just for stories whose short render is missing (the only case the
 *  gates read it), so on rows WITH a done short the
 *  voiceover/scene_* details read as absent/zero. `ready`, `missing`
 *  and `blocking` are exact — they suppress those sub-gates when the
 *  short exists, in both paths. Callers that need full details for a
 *  single story (the cron's structured log) use
 *  evaluateAssetCompleteness. */
export async function evaluateAssetCompletenessForStories(
  storyIds: readonly string[],
): Promise<Map<string, AssetCompleteness>> {
  const out = new Map<string, AssetCompleteness>();
  if (storyIds.length === 0) return out;

  const placeholders = storyIds.map(() => "?").join(", ");

  // Everything the gates need from `stories`, except short_config
  // (fetched below for the short-missing subset only — it's the one
  // large blob on the row). body collapses to a presence flag in SQL
  // so a page of rows doesn't ship full article bodies; the derive
  // only ever null/trim-checks it. The correlated subquery mirrors
  // latestDoneShortRenderForStory + the output_url truthiness check:
  // the LATEST done-with-props render decides, not "any done render".
  interface BatchStoryRow extends ThumbnailColumns {
    id: string;
    status: string | null;
    hero_image: string | null;
    video_url: string | null;
    body_present: number;
    short_render_ok: number | null;
  }
  const stories = await all<BatchStoryRow>(
    `SELECT id, status, hero_image, video_url,
            CASE WHEN body IS NOT NULL AND TRIM(body) <> '' THEN 1 ELSE 0 END
              AS body_present,
            hero_image_landscape, thumbnail_image, thumbnail_image_landscape,
            thumbnail_image_square,
            (SELECT CASE WHEN output_url IS NOT NULL AND output_url <> ''
                         THEN 1 ELSE 0 END
               FROM short_renders
               WHERE story_id = stories.id
                 AND status = 'done' AND props IS NOT NULL
               ORDER BY requested_at DESC LIMIT 1) AS short_render_ok
     FROM stories WHERE id IN (${placeholders})`,
    [...storyIds],
  );

  // First poll row per story — the map keeps the first hit, matching
  // getPollByStoryId's one() on the same un-ordered SELECT.
  const pollRows = await all<{
    story_id: string;
    enabled: number;
    question: string | null;
  }>(
    `SELECT story_id, enabled, question FROM polls
     WHERE story_id IN (${placeholders})`,
    [...storyIds],
  );
  const pollByStory = new Map<string, (typeof pollRows)[number]>();
  for (const p of pollRows) {
    if (!pollByStory.has(p.story_id)) pollByStory.set(p.story_id, p);
  }

  // short_config only for the short-missing subset (see doc comment).
  const needSceneIds = stories
    .filter((s) => Number(s.short_render_ok ?? 0) !== 1)
    .map((s) => s.id);
  const configByStory = new Map<string, string | null>();
  if (needSceneIds.length > 0) {
    const configRows = await all<{ id: string; short_config: string | null }>(
      `SELECT id, short_config FROM stories
       WHERE id IN (${needSceneIds.map(() => "?").join(", ")})`,
      [...needSceneIds],
    );
    for (const c of configRows) configByStory.set(c.id, c.short_config);
  }

  for (const s of stories) {
    const poll = pollByStory.get(s.id);
    const pollReady =
      !!poll &&
      poll.enabled === 1 &&
      typeof poll.question === "string" &&
      poll.question.trim() !== "";
    out.set(
      s.id,
      deriveAssetCompleteness({
        storyStatus: s.status,
        bodyPresent: Number(s.body_present) === 1,
        heroImage: s.hero_image,
        videoUrl: s.video_url,
        thumbs: {
          hero_image_landscape: s.hero_image_landscape,
          thumbnail_image: s.thumbnail_image,
          thumbnail_image_landscape: s.thumbnail_image_landscape,
          thumbnail_image_square: s.thumbnail_image_square,
        },
        shortRenderPresent: Number(s.short_render_ok ?? 0) === 1,
        sceneState: parseShortConfigState(configByStory.get(s.id) ?? null),
        pollReady,
      }),
    );
  }

  console.info("[asset gate] batch", {
    requested: storyIds.length,
    evaluated: out.size,
  });
  return out;
}

// ─── Internals ────────────────────────────────────────────────────────────────

/** Everything the gate derivation needs, pre-loaded. The single-story
 *  path fills this from the per-row helpers; the batch path from three
 *  IN-list queries. All gate LOGIC lives in deriveAssetCompleteness so
 *  the two paths cannot drift. */
interface GateInputs {
  storyStatus: string | null;
  bodyPresent: boolean;
  heroImage: string | null;
  videoUrl: string | null;
  thumbs: ThumbnailColumns;
  shortRenderPresent: boolean;
  sceneState: SceneState;
  pollReady: boolean;
}

/** Pure gate derivation — the single source of truth for "what blocks
 *  a publish". Assumes the story row exists (callers early-exit with
 *  story_missing). */
function deriveAssetCompleteness(inputs: GateInputs): AssetCompleteness {
  const missing: AssetGate[] = [];

  // Compose the manual publish gate so this stays in lock-step with
  // publishReviewedStoryAction and the review page. It only null/trim-
  // checks body, so a presence flag rehydrates to a sentinel — the
  // batch path computes presence in SQL to avoid shipping full bodies.
  // The source arg is permissive on purpose: every source-derived
  // reason it can emit ("source row hasn't finished processing",
  // "source row has no linked story_id") is unmapped below, so
  // fetching the real reddit_source row was a dead query.
  const baseReadiness = evaluatePublishReadiness(
    {
      status: inputs.storyStatus,
      body: inputs.bodyPresent ? "present" : "",
      hero_image: inputs.heroImage,
      video_url: inputs.videoUrl,
    },
    { status: "used", story_id: "asset-gate" },
  );

  // Body + hero come from the manual gate. The other strings it can
  // emit are mapped explicitly so we never surface an unmapped string
  // up to the cron's structured log. Unmapped base reasons ("story is
  // archived", the source reasons) are covered by story_missing OR
  // already_published OR the callers' own status filters.
  const baseMessages = new Set(baseReadiness.missing);
  if (baseMessages.has("story body is empty")) missing.push("body");
  if (baseMessages.has("hero image is missing")) missing.push("hero_image");
  if (baseMessages.has("story is already published")) {
    missing.push("already_published");
  }

  const { thumbs } = inputs;
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

  if (!inputs.shortRenderPresent) missing.push("short_render");

  // stories.video_url — what /v/[slug] actually plays. Required
  // independently of the render row above; see gate 3b in the header.
  const videoUrlPresent = nonEmpty(inputs.videoUrl);
  if (!videoUrlPresent) missing.push("video_url");

  // Voiceover + scene images are INPUTS to the short render. A
  // completed short_renders row is the proof that both existed at
  // render time, so we trust the render and skip the sub-checks.
  // When the short is missing we still walk short_config to surface
  // which input is gone so the operator (and the cron's structured
  // log) can see whether to re-enqueue voice or scenes. The
  // alternative — checking short_config unconditionally — produced
  // false-negative gates on legacy rows whose short_config was
  // never seeded by the editor (no voiceover_url even though the
  // audio existed at render time). PR follow-up to #99.
  const { sceneState } = inputs;
  if (!inputs.shortRenderPresent) {
    if (!sceneState.voiceoverPresent) missing.push("voiceover");
    if (
      sceneState.scenesTotal === 0 ||
      sceneState.scenesWithUrl !== sceneState.scenesTotal
    ) {
      missing.push("scene_images");
    }
  }

  if (!inputs.pollReady) missing.push("poll");

  const blocking = missing.filter((g) => !ADVISORY_GATES.has(g));
  return {
    ready: blocking.length === 0,
    missing,
    blocking,
    details: {
      body_present: inputs.bodyPresent,
      hero_image_present: !!inputs.heroImage,
      hero_image_landscape_present: nonEmpty(thumbs.hero_image_landscape),
      thumbnail_image_present: nonEmpty(thumbs.thumbnail_image),
      thumbnail_image_landscape_present: nonEmpty(
        thumbs.thumbnail_image_landscape,
      ),
      thumbnail_image_square_present: nonEmpty(thumbs.thumbnail_image_square),
      short_render_present: inputs.shortRenderPresent,
      video_url_present: videoUrlPresent,
      voiceover_present: sceneState.voiceoverPresent,
      scenes_with_url: sceneState.scenesWithUrl,
      scenes_total: sceneState.scenesTotal,
      poll_present_and_enabled: inputs.pollReady,
      story_status: inputs.storyStatus,
    },
  };
}

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
    // story_missing / wrong_kind are never advisory, so the blocking
    // set mirrors `missing` verbatim on this early-exit path.
    blocking: partial.missing,
    details: {
      body_present: false,
      hero_image_present: false,
      hero_image_landscape_present: false,
      thumbnail_image_present: false,
      thumbnail_image_landscape_present: false,
      thumbnail_image_square_present: false,
      short_render_present: false,
      video_url_present: false,
      voiceover_present: false,
      scenes_with_url: 0,
      scenes_total: 0,
      poll_present_and_enabled: false,
      story_status: null,
    },
  };
}
