// Vercel Pro cron orchestrator for the short_renders queue.
//
// Mirrors /api/render_video for the 40-60s article shorts, with one structural
// difference: long-form ships the story's pre-built video_config to Cloud Run
// (images already generated, Cloud Run only composes), whereas a short is
// generated from scratch. So the shorts Cloud Run service does the heavy work
// (script -> gpt-image-2 frames -> voice -> Remotion render) and this route just
// claims a queued row, dispatches the story id + creation options, and writes
// the returned URL back.
//
// Auth: CRON_SECRET Bearer (matches the other drains).
// Idempotency: claimNextShortRender is atomic, so two concurrent cron firings
// cannot grab the same row; the conditional finish/fail writes prevent a settled
// row being overwritten by a late retry.
//
// The render runs on the SAME Cloud Run /render endpoint the long-form video
// uses (DoodleShort renders any inputProps), so CLOUD_RUN_RENDER_URL is reused.
// The generation drain (api/drain_short_renders.py) builds + stores the props
// first; this route only claims rows that already have props.

import { NextResponse, type NextRequest } from "next/server";
import { Agent, fetch as undiciFetch } from "undici";
import {
  claimNextShortRender,
  failShortRender,
  finishShortRender,
} from "@/lib/short-render-queue";
import { getStory, setStoryShortConfigJson } from "@/lib/repo";
import { one } from "@/lib/db";
import { resolveShortSegments } from "@/lib/short-segments";
import { parseShortConfig, type ShortConfig } from "@/lib/short-config";
import { rewriteStoredMediaUrlsDeep } from "@/lib/media-url";
import { publishShortToFacebook } from "@/lib/publish-to-facebook";
import { publishShortToFacebookStory } from "@/lib/publish-to-facebook-story";
import { publishShortToInstagram } from "@/lib/publish-to-instagram";
import { publishShortToInstagramStory } from "@/lib/publish-to-instagram-story";
import { publishShortToYouTube } from "@/lib/publish-to-youtube";
import { publishShortToTikTok } from "@/lib/publish-to-tiktok";
import { ensureSeoMetadataForStory } from "@/lib/seo-metadata";

// A short runs kie image generation + Remotion render, the longest job in the
// app, so override undici's 300s default timeouts. Vercel Pro's 800s cron cap is
// the real ceiling; 900s here lets the cron deadline win over undici.
const longRunAgent = new Agent({
  headersTimeout: 900_000,
  bodyTimeout: 900_000,
  keepAliveTimeout: 60_000,
});

const DEADLINE_MS = 770_000;

// Post-roll hold (ms) injected onto every short's props before dispatch. Holds
// the final scene on screen this much longer than the narration so the closing
// word finishes before the outro splices on. Injected here (not stored on the
// short_renders row) for two reasons: it applies to re-renders of shorts that
// were generated before this shipped, and it can never double-count across the
// A/B/C re-render lanes. The DoodleShort composition reads `end_hold_ms` and
// grows both its duration and the last frame's window. Mirror of
// pipeline/shorts_render.SHORT_END_HOLD_MS for the local render path.
const SHORT_END_HOLD_MS = 1500;

interface CloudRunRenderResponse {
  url?: unknown;
  error?: unknown;
}

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[dispatch_short_render ${event}]`, JSON.stringify(fields));
}

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  return header === `Bearer ${expected}`;
}

async function postToCloudRun(
  url: string,
  body: object,
  secret: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const resp = await undiciFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEADLINE_MS),
      dispatcher: longRunAgent,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        ok: false,
        error: `cloud-run HTTP ${resp.status}: ${text.slice(0, 300)}`,
      };
    }
    const data = (await resp.json().catch(() => null)) as
      | CloudRunRenderResponse
      | null;
    if (!data || typeof data.url !== "string" || data.url.length === 0) {
      return {
        ok: false,
        error: `cloud-run returned malformed body: ${JSON.stringify(data).slice(0, 300)}`,
      };
    }
    return { ok: true, url: data.url };
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

interface ResolvedSpliceSegments {
  /** Normalized GCS urls Cloud Run actually splices. */
  intro: string | null;
  outro: string | null;
  /** Segment row ids the planner stamps onto short_config so the next
   *  preview can detect "intro/outro override changed since last
   *  render" and surface Lane A. Null when no segment spliced (skip
   *  flag or resolver miss). */
  intro_segment_id: string | null;
  outro_segment_id: string | null;
  /** Seconds at which the spoken cold-open hook ends. When > 0 AND an
   *  intro is being spliced, Cloud Run reorders to
   *  [body_hook][intro][body_rest][outro] so the hook lands BEFORE the
   *  brand stinger. Per _plans/2026-06-28-hook-before-brand-intro.md.
   *  Sourced from `inputProps.hook_end_ms` which the Python pipeline
   *  computes from the alignment data; null when the pipeline can't
   *  compute a boundary (legacy short_renders rows, alignment drift). */
  hookEndSec: number | null;
}

/** Resolve the 9:16 intro/outro for a short, defensively (everything-null on any
 *  error so a missing/misconfigured segment degrades to a body-only short
 *  instead of failing the row). Walks the short-specific chain in
 *  lib/short-segments: short_config override -> per-story columns -> global
 *  9:16 active. Shorts are always 9:16, so the aspect is fixed. */
async function resolveShortSegmentsSafe(
  story: Awaited<ReturnType<typeof getStory>>,
): Promise<ResolvedSpliceSegments> {
  const empty: ResolvedSpliceSegments = {
    intro: null,
    outro: null,
    intro_segment_id: null,
    outro_segment_id: null,
    hookEndSec: null,
  };
  if (!story) return empty;
  try {
    let config: ShortConfig | null = null;
    if (story.short_config) {
      const parsed = parseShortConfig(JSON.parse(story.short_config));
      if (parsed.ok) config = parsed.config;
    }
    const resolved = await resolveShortSegments(config, story);
    return {
      intro: resolved.intro.segment?.normalized_url ?? null,
      outro: resolved.outro.segment?.normalized_url ?? null,
      intro_segment_id: resolved.intro.segment?.id ?? null,
      outro_segment_id: resolved.outro.segment?.id ?? null,
      // hookEndSec is populated from inputProps.hook_end_ms by the
      // caller below; the segment resolver doesn't know about the
      // hook (it's a script-side concept, not a per-story setting).
      hookEndSec: null,
    };
  } catch {
    return empty;
  }
}

/** Extract the hook end timestamp from inputProps (the Python pipeline
 *  writes it onto the props row when building a short). Returns
 *  `{ hookEndSec, propsStripped }` where `propsStripped` is true when
 *  the key was removed from inputProps (so Remotion never receives a
 *  phantom prop). Returns null when the value is missing, non-finite,
 *  or non-positive — the splicer falls back to legacy ordering in that
 *  case. Per _plans/2026-06-28-hook-before-brand-intro.md. Exported for
 *  pure-logic tests; the dispatcher is the only production caller. */
export function extractHookEndSecFromProps(inputProps: unknown): {
  hookEndSec: number | null;
  propsStripped: boolean;
} {
  if (!inputProps || typeof inputProps !== "object" || Array.isArray(inputProps)) {
    return { hookEndSec: null, propsStripped: false };
  }
  const obj = inputProps as Record<string, unknown>;
  const raw = obj.hook_end_ms;
  // Strip the key regardless of validity so Remotion can't see it as a
  // phantom composition prop. A malformed value just falls through with
  // hookEndSec = null (splice uses legacy ordering).
  let stripped = false;
  if ("hook_end_ms" in obj) {
    delete obj.hook_end_ms;
    stripped = true;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return { hookEndSec: null, propsStripped: stripped };
  }
  return { hookEndSec: raw / 1000, propsStripped: stripped };
}

/** Strip the `hook` field from inputProps before they reach the
 *  DoodleShort Remotion composition. The Python pipeline preserves
 *  `script.hook` on the props dict so the SEPARATE poster render
 *  pipeline (/render-poster, called from `ensureShortPoster`) can
 *  read it — but DoodleShort itself doesn't accept a `hook` prop,
 *  and Remotion's prop validator treats unknown fields as a phantom
 *  composition prop. Same pattern as extractHookEndSecFromProps.
 *  Per _plans/2026-06-28-phase-2-social-poster-render.md (Part 0).
 *  Exported for pure-logic tests; the dispatcher is the only
 *  production caller. */
export function stripHookFromProps(inputProps: unknown): {
  hook: string | null;
  propsStripped: boolean;
} {
  if (!inputProps || typeof inputProps !== "object" || Array.isArray(inputProps)) {
    return { hook: null, propsStripped: false };
  }
  const obj = inputProps as Record<string, unknown>;
  const raw = obj.hook;
  let stripped = false;
  if ("hook" in obj) {
    delete obj.hook;
    stripped = true;
  }
  if (typeof raw !== "string" || raw.length === 0) {
    return { hook: null, propsStripped: stripped };
  }
  return { hook: raw, propsStripped: stripped };
}

/** Strip the `poster_text` field from inputProps before they reach
 *  DoodleShort. Same rationale as stripHookFromProps: the Python
 *  pipeline preserves the climax-revealing line on `props` for the
 *  /render-poster endpoint, but DoodleShort doesn't accept it as a
 *  composition prop. Per the 2026-06-29 prompt-update scope addition
 *  to _plans/2026-06-28-phase-2-social-poster-render.md. */
export function stripPosterTextFromProps(inputProps: unknown): {
  posterText: string | null;
  propsStripped: boolean;
} {
  if (!inputProps || typeof inputProps !== "object" || Array.isArray(inputProps)) {
    return { posterText: null, propsStripped: false };
  }
  const obj = inputProps as Record<string, unknown>;
  const raw = obj.poster_text;
  let stripped = false;
  if ("poster_text" in obj) {
    delete obj.poster_text;
    stripped = true;
  }
  if (typeof raw !== "string" || raw.length === 0) {
    return { posterText: null, propsStripped: stripped };
  }
  return { posterText: raw, propsStripped: stripped };
}

async function serve(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    namespacedLog("auth_fail", {
      ip: req.headers.get("x-forwarded-for") ?? "unknown",
    });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const cloudRunUrl = process.env.CLOUD_RUN_RENDER_URL;
  const cronSecret = process.env.CRON_SECRET;
  if (!cloudRunUrl || !cronSecret) {
    namespacedLog("config_missing", {
      cloud_run_url_set: Boolean(cloudRunUrl),
      cron_secret_set: Boolean(cronSecret),
    });
    return NextResponse.json(
      { error: "CLOUD_RUN_RENDER_URL or CRON_SECRET not configured" },
      { status: 500 },
    );
  }

  const claimed = await claimNextShortRender();
  if (!claimed) {
    namespacedLog("idle", {});
    return NextResponse.json({ drained: 0 });
  }

  namespacedLog("claimed", {
    render_id: claimed.id,
    story_id: claimed.story_id,
    narration_style: claimed.narration_style,
    length_preset: claimed.length_preset,
  });

  // The generation drain stored the built DoodleShort props on the row. Parse
  // them and hand them to the SAME Cloud Run /render endpoint long-form uses
  // (DoodleShort renders any inputProps; its resolveSrc accepts remote URLs).
  let inputProps: unknown;
  try {
    inputProps = JSON.parse(claimed.props ?? "");
  } catch {
    const err = "short_renders.props missing or not valid JSON";
    namespacedLog("props_malformed", { render_id: claimed.id });
    await failShortRender(claimed.id, err);
    return NextResponse.json({
      drained: 1,
      render_id: claimed.id,
      status: "error",
      error: err,
    });
  }

  // Hold the last scene past the narration so the closing word isn't clipped
  // by the outro. Applied to whatever props the row carries (full generation
  // or any re-render lane), so old shorts pick it up on their next render too.
  if (inputProps && typeof inputProps === "object" && !Array.isArray(inputProps)) {
    (inputProps as Record<string, unknown>).end_hold_ms = SHORT_END_HOLD_MS;
  }

  // Pull the cold-open hook boundary out of inputProps and strip it so it
  // never reaches Remotion as a phantom prop. The Python build_short_props
  // writes `hook_end_ms` from the alignment data; we forward the seconds-
  // form to Cloud Run via the segments POST field so the splice can reorder
  // to [body_hook][intro][body_rest][outro]. Per
  // _plans/2026-06-28-hook-before-brand-intro.md. When the row predates the
  // pipeline change (no hook_end_ms) the splice falls through to the legacy
  // [intro][body][outro] ordering — no regression for old rows.
  const { hookEndSec, propsStripped: hookEndStripped } =
    extractHookEndSecFromProps(inputProps);

  // Strip the `hook` string from inputProps. Python's build_short_props
  // (Part 0 of _plans/2026-06-28-phase-2-social-poster-render.md) preserves
  // the spoken cold-open line on the props dict so the SEPARATE poster
  // renderer (`/render-poster`, called from `ensureShortPoster`) can
  // surface it as graphic typography on the social cover. The video render
  // path (this dispatcher) does NOT need it — DoodleShort doesn't accept a
  // `hook` prop and Remotion treats unknown fields as a phantom composition
  // prop. We strip but don't forward — the poster renderer reads `hook`
  // directly from `short_renders.props` via its own helper.
  const { propsStripped: hookStripped } = stripHookFromProps(inputProps);

  // Same pattern for `poster_text` — the climax-revealing line generated
  // by the script LLM (2026-06-29 prompt update) lives on props for the
  // poster renderer to read. DoodleShort never sees it.
  const { propsStripped: posterTextStripped } =
    stripPosterTextFromProps(inputProps);

  // Resolve the 9:16 intro/outro so Cloud Run splices them around the short,
  // same as the long-form render (shorts are always 9:16). Body-only if none.
  const story = await getStory(claimed.story_id);
  const segments = await resolveShortSegmentsSafe(story);
  // Hook-first reorder only meaningful when an intro will sit in front
  // of the body; the Cloud Run side also enforces this, but mirroring
  // the gate here keeps the outgoing POST shape honest.
  if (hookEndSec !== null && segments.intro) {
    segments.hookEndSec = hookEndSec;
  }

  // Walk inputProps and rewrite any persisted legacy GCS URLs onto
  // MEDIA_PUBLIC_BASE before they cross out to Cloud Run. Cloud Run's
  // Remotion render fetches every URL via HTTP; if a row's props blob still
  // carries pre-2026-06-22 `storage.googleapis.com` URLs and GCS public read
  // is off, every fetch 404s. The rewriter is inert when the base is unset
  // (dev / pre-cutover) and only touches scheme-prefixed legacy GCS URLs —
  // captions, prose, and external assets pass through unchanged. Plan:
  // _plans/2026-06-23-pipeline-outbound-url-rewriter.md.
  const propsRewrote = rewriteStoredMediaUrlsDeep(inputProps);
  // Segments are deliberately NOT rewritten. Cloud Run downloads them via
  // the authenticated GCS SDK (`video/server/render.ts:downloadSegment`,
  // through `storage.bucket(bucket).file(key)`), so public-read state
  // does not matter. Worse: `parseGcsSegmentUrl` on the Cloud Run side
  // only accepts the legacy `storage.googleapis.com/<bucket>/<key>.mp4`
  // shape and returns null for any other host. Rewriting to
  // `media.lorewire.com/<key>` made every parse return null, which made
  // `spliceWithSegments` log `reason: invalid-intro-url` and skip the
  // splice entirely — that is the 2026-06-23 "intro and outro missing
  // even after manual override" bug, traced to the consistency-rewrite
  // added in 3855d5f. When the segments uploader eventually moves to R2,
  // the durable fix is to extend `parseGcsSegmentUrl` to also recognise
  // `MEDIA_PUBLIC_BASE/<key>` — until then, keep the legacy GCS shape
  // intact end-to-end here.
  namespacedLog("rewrite", {
    render_id: claimed.id,
    props_rewrote: propsRewrote,
    segments_rewrote: 0,
    intro_present: Boolean(segments.intro),
    outro_present: Boolean(segments.outro),
    hook_end_sec: segments.hookEndSec,
    hook_end_stripped: hookEndStripped,
    hook_stripped: hookStripped,
    poster_text_stripped: posterTextStripped,
  });

  // Cloud Run writes the MP4 to GCS key `<storyId>/video.mp4`. We must NOT pass
  // the bare story_id or the short would overwrite the long-form video at the
  // same key (and stories.video_url would then serve the short). Suffix it so
  // the short lands at `<story>-short/video.mp4`, matching the local path's
  // `<story>-short` namespace (pipeline/shorts_render.SHORT_ID_SUFFIX).
  const result = await postToCloudRun(
    `${cloudRunUrl.replace(/\/$/, "")}/render`,
    {
      storyId: `${claimed.story_id}-short`,
      configHash: claimed.config_hash,
      inputProps,
      segments,
    },
    cronSecret,
  );

  if (!result.ok) {
    namespacedLog("failed", {
      render_id: claimed.id,
      story_id: claimed.story_id,
      error: result.error,
    });
    await failShortRender(claimed.id, result.error);
    // Return 200 so Vercel cron does not retry (the row is already errored).
    return NextResponse.json({
      drained: 1,
      render_id: claimed.id,
      status: "error",
      error: result.error,
    });
  }

  namespacedLog("done", {
    render_id: claimed.id,
    story_id: claimed.story_id,
    url_bytes: result.url.length,
    intro_segment_id: segments.intro_segment_id,
    outro_segment_id: segments.outro_segment_id,
  });
  await finishShortRender(claimed.id, result.url);
  // Stamp the spliced segment ids onto short_config so the editor's render
  // plan can detect "intro/outro override changed since last render" and
  // surface Lane A on the override picker. Best-effort: a stamp failure
  // logs + continues; the worst case is the planner shows "no changes"
  // until something else triggers a render plan refresh.
  await stampLastRenderedSegments(claimed.story_id, {
    intro_segment_id: segments.intro_segment_id,
    outro_segment_id: segments.outro_segment_id,
  }).catch((err) => {
    namespacedLog("stamp_segments_failed", {
      render_id: claimed.id,
      story_id: claimed.story_id,
      err: String(err),
    });
  });
  // Best-effort LLM-generated SEO metadata regeneration. Runs BEFORE
  // the publishers so they can use the freshly-generated per-platform
  // titles/descriptions/captions/tags instead of the template defaults.
  // Idempotent: skips when the existing metadata is fresh (no story
  // update since the last generation) and the auto-regenerate setting
  // is on. A failure here NEVER blocks publishing — publishers fall
  // through to templates on missing/stale metadata. Plan:
  // _plans/2026-06-24-llm-seo-metadata.md.
  await ensureSeoMetadataForRender(claimed.story_id).catch((err) => {
    namespacedLog("seo_metadata_unhandled", {
      render_id: claimed.id,
      story_id: claimed.story_id,
      err: String(err),
    });
  });

  // Best-effort auto-publish to the LoreWire Facebook Page. Gated by the
  // `publisher.facebook.auto_publish` setting (default off) and dedup'd
  // at story level in publishShortToFacebook. A failure lands in
  // facebook_posts with status='failed' so the retry cron can pick it
  // up; it must never break the render route's response. Plan:
  // _plans/2026-06-23-facebook-auto-publish.md.
  await publishShortToFacebookForRender(claimed.story_id, claimed.id, result.url, story).catch(
    (err) => {
      namespacedLog("facebook_publish_unhandled", {
        render_id: claimed.id,
        story_id: claimed.story_id,
        err: String(err),
      });
    },
  );
  // Best-effort auto-publish as an Instagram Reel. Same shape as the FB
  // hook above (gated by its own toggle, dedup'd at story level, failures
  // land in instagram_posts for the retry cron). Runs SEQUENTIALLY after
  // FB — chose sequential over parallel for log readability + simpler
  // incident triage. Plan:
  // _plans/2026-06-24-instagram-auto-publish.md.
  await publishShortToInstagramForRender(claimed.story_id, claimed.id, result.url, story).catch(
    (err) => {
      namespacedLog("instagram_publish_unhandled", {
        render_id: claimed.id,
        story_id: claimed.story_id,
        err: String(err),
      });
    },
  );
  // Best-effort cross-post to FB Stories. Independent toggle
  // (publisher.facebook.auto_publish_story, default off). Same
  // gating + dedup + retry-cron shape as the FB Reel publish above,
  // failures land in facebook_stories. Plan:
  // _plans/2026-06-25-instagram-facebook-stories-cross-publish.md.
  await publishShortToFacebookStory({
    storyId: claimed.story_id,
    renderId: claimed.id,
    videoUrl: result.url,
    trigger: "auto",
  }).catch((err) => {
    namespacedLog("facebook_story_publish_unhandled", {
      render_id: claimed.id,
      story_id: claimed.story_id,
      err: String(err),
    });
  });
  // Best-effort cross-post to IG Stories. Independent toggle
  // (publisher.instagram.auto_publish_story, default off). Same
  // gating + dedup + retry-cron shape; failures land in
  // instagram_stories. Plan:
  // _plans/2026-06-25-instagram-facebook-stories-cross-publish.md.
  await publishShortToInstagramStory({
    storyId: claimed.story_id,
    renderId: claimed.id,
    videoUrl: result.url,
    trigger: "auto",
  }).catch((err) => {
    namespacedLog("instagram_story_publish_unhandled", {
      render_id: claimed.id,
      story_id: claimed.story_id,
      err: String(err),
    });
  });
  // Best-effort auto-publish to the LoreWire YouTube channel. Same
  // shape as the FB / IG hooks above: gated by its own toggle,
  // dedup'd at story level, failures land in youtube_posts for the
  // retry cron, never breaks the render route response. Plan:
  // _plans/2026-06-24-youtube-and-tiktok-auto-publish-and-socials-admin.md.
  await publishShortToYouTubeForRender(
    claimed.story_id,
    claimed.id,
    result.url,
    story,
  ).catch((err) => {
    namespacedLog("youtube_publish_unhandled", {
      render_id: claimed.id,
      story_id: claimed.story_id,
      err: String(err),
    });
  });
  // Best-effort auto-publish to the LoreWire TikTok account. Until
  // TikTok approves the Content Posting API audit, this lands in the
  // LoreWire TikTok app Inbox (drafts mode); after audit it goes live
  // directly. Same gating + dedup + retry-cron shape. Plan:
  // _plans/2026-06-24-youtube-and-tiktok-auto-publish-and-socials-admin.md.
  await publishShortToTikTokForRender(
    claimed.story_id,
    claimed.id,
    result.url,
    story,
  ).catch((err) => {
    namespacedLog("tiktok_publish_unhandled", {
      render_id: claimed.id,
      story_id: claimed.story_id,
      err: String(err),
    });
  });
  return NextResponse.json({
    drained: 1,
    render_id: claimed.id,
    status: "done",
    url: result.url,
  });
}

/** Build the caption context from the story row + the latest published
 *  article (for the article URL) and dispatch to publishShortToFacebook
 *  with `trigger: 'auto'`. Lookup is best-effort: a missing article
 *  falls back to the lorewire homepage so the caption renderer can
 *  still substitute {{article_url}}. */
async function publishShortToFacebookForRender(
  storyId: string,
  renderId: string,
  videoUrl: string,
  story: Awaited<ReturnType<typeof getStory>>,
): Promise<void> {
  const origin =
    process.env.NEXT_PUBLIC_SITE_ORIGIN || "https://www.lorewire.com";
  const article = await one<{ language: string; slug: string }>(
    "SELECT language, slug FROM articles WHERE story_id = ? AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1",
    [storyId],
  ).catch(() => null);
  const articleUrl = article
    ? `${origin}/articles/${article.language}/${article.slug}`
    : origin;
  await publishShortToFacebook({
    storyId,
    renderId,
    videoUrl,
    trigger: "auto",
    context: {
      hook: null,
      title: story?.title ?? null,
      article_url: articleUrl,
    },
  });
}

/** IG mirror of publishShortToFacebookForRender. Same caption-context
 *  construction; dispatches to publishShortToInstagram which runs the
 *  2-step create-container/poll/publish flow. Plan:
 *  _plans/2026-06-24-instagram-auto-publish.md. */
async function publishShortToInstagramForRender(
  storyId: string,
  renderId: string,
  videoUrl: string,
  story: Awaited<ReturnType<typeof getStory>>,
): Promise<void> {
  const origin =
    process.env.NEXT_PUBLIC_SITE_ORIGIN || "https://www.lorewire.com";
  const article = await one<{ language: string; slug: string }>(
    "SELECT language, slug FROM articles WHERE story_id = ? AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1",
    [storyId],
  ).catch(() => null);
  const articleUrl = article
    ? `${origin}/articles/${article.language}/${article.slug}`
    : origin;
  await publishShortToInstagram({
    storyId,
    renderId,
    videoUrl,
    trigger: "auto",
    context: {
      hook: null,
      title: story?.title ?? null,
      article_url: articleUrl,
    },
  });
}

/** YouTube mirror of the FB/IG `*ForRender` helpers. Builds the metadata
 *  context (story title + category + article URL) and dispatches to
 *  publishShortToYouTube with `trigger: 'auto'`. The YT publisher
 *  resolves title / description / tags from the templates in the
 *  Socials settings + the per-category overrides. The category token
 *  picks up the story.category column. Article lookup is best-effort:
 *  a missing article falls back to the lorewire homepage. */
async function publishShortToYouTubeForRender(
  storyId: string,
  renderId: string,
  videoUrl: string,
  story: Awaited<ReturnType<typeof getStory>>,
): Promise<void> {
  const origin =
    process.env.NEXT_PUBLIC_SITE_ORIGIN || "https://www.lorewire.com";
  const article = await one<{ language: string; slug: string }>(
    "SELECT language, slug FROM articles WHERE story_id = ? AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1",
    [storyId],
  ).catch(() => null);
  const articleUrl = article
    ? `${origin}/articles/${article.language}/${article.slug}`
    : origin;
  await publishShortToYouTube({
    storyId,
    renderId,
    videoUrl,
    trigger: "auto",
    context: {
      hook: null,
      title: story?.title ?? null,
      article_url: articleUrl,
      category: story?.category ?? null,
    },
  });
}

/** Look up the article URL for the SEO metadata generator — same shape
 *  as resolveArticleUrlForStory in the per-publisher helpers above, but
 *  inlined here because seo-metadata.ts only needs the URL string. */
async function ensureSeoMetadataForRender(storyId: string): Promise<void> {
  const origin =
    process.env.NEXT_PUBLIC_SITE_ORIGIN || "https://www.lorewire.com";
  const article = await one<{ language: string; slug: string }>(
    "SELECT language, slug FROM articles WHERE story_id = ? AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1",
    [storyId],
  ).catch(() => null);
  const articleUrl = article
    ? `${origin}/articles/${article.language}/${article.slug}`
    : origin;
  await ensureSeoMetadataForStory({ storyId, articleUrl });
}

/** TikTok mirror. The TT publisher runs the OAuth refresh → creator
 *  info query → init → poll pipeline against the Content Posting
 *  API. post_mode (inbox vs direct) is read from settings inside
 *  the publisher; this helper just supplies the per-render data. */
async function publishShortToTikTokForRender(
  storyId: string,
  renderId: string,
  videoUrl: string,
  story: Awaited<ReturnType<typeof getStory>>,
): Promise<void> {
  const origin =
    process.env.NEXT_PUBLIC_SITE_ORIGIN || "https://www.lorewire.com";
  const article = await one<{ language: string; slug: string }>(
    "SELECT language, slug FROM articles WHERE story_id = ? AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1",
    [storyId],
  ).catch(() => null);
  const articleUrl = article
    ? `${origin}/articles/${article.language}/${article.slug}`
    : origin;
  await publishShortToTikTok({
    storyId,
    renderId,
    videoUrl,
    trigger: "auto",
    context: {
      hook: null,
      title: story?.title ?? null,
      article_url: articleUrl,
      category: story?.category ?? null,
    },
  });
}

async function stampLastRenderedSegments(
  storyId: string,
  segments: { intro_segment_id: string | null; outro_segment_id: string | null },
): Promise<void> {
  const story = await getStory(storyId);
  if (!story || !story.short_config) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(story.short_config);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const next = {
    ...(parsed as Record<string, unknown>),
    _last_rendered_segments: segments,
  };
  await setStoryShortConfigJson(storyId, JSON.stringify(next));
}

// Vercel cron calls GET; POST is a manual kick. Both wire to serve().
export async function GET(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export const maxDuration = 800;
