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
import { resolveShortSegments } from "@/lib/short-segments";
import { parseShortConfig, type ShortConfig } from "@/lib/short-config";

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
    };
  } catch {
    return empty;
  }
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

  // Resolve the 9:16 intro/outro so Cloud Run splices them around the short,
  // same as the long-form render (shorts are always 9:16). Body-only if none.
  const story = await getStory(claimed.story_id);
  const segments = await resolveShortSegmentsSafe(story);

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
  return NextResponse.json({
    drained: 1,
    render_id: claimed.id,
    status: "done",
    url: result.url,
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
