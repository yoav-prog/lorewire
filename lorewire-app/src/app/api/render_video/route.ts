// Phase 2 of _plans/2026-06-14-cloud-run-render.md.
//
// Vercel Pro cron orchestrator for the video_renders queue. Fires every
// minute, claims the oldest queued row, POSTs synchronously to the
// Cloud Run service, writes the returned URL back to Postgres. No
// separate drain — Cloud Run renders inside one Vercel cron invocation
// (Vercel Pro's 800s cron timeout covers any LoreWire render).
//
// Why a Next App-Router route handler (route.ts) instead of a
// pipeline-style Python drain? Two reasons:
//   1. The other drains (image_renders, story_jobs, voice_renders) all
//      compose a Python worker; Cloud Run is the worker here. The
//      orchestrator side is pure orchestration — claim, POST, write —
//      and Node + fetch fit that perfectly.
//   2. The deploy step (`vendor_pipeline.mjs`) already vendors the
//      Python pipeline into `lorewire-app/api/_lib/` for the Python
//      drains. Adding another Python drain would duplicate effort
//      when Node serves the same need with one less language.
//
// Auth: CRON_SECRET Bearer (matches the other drains).
// Idempotency: the atomic claim in claimNextRender() prevents two
// concurrent cron firings from grabbing the same row. The conditional
// finish/fail writes prevent a settled row from being overwritten by
// a late retry.
//
// Failure modes handled:
//   - Empty queue → return 200 with `{ drained: 0 }`.
//   - Cloud Run 5xx or network error → failRender with the message,
//     return 200 with `{ drained: 1, error: '...' }` (Vercel cron
//     treats 5xx as a retry signal, and we DON'T want retries — the
//     row is already marked errored).
//   - Cloud Run returns 200 but body is malformed → same as 5xx.
//   - Vercel times out (>800s) → Cloud Run still completes + the next
//     tick sees the row in 'rendering' but can't claim it; a follow-up
//     phase will add a stale-reap helper.

import { NextResponse, type NextRequest } from "next/server";
import { Agent, fetch as undiciFetch } from "undici";
import {
  claimNextRender,
  failRender,
  finishRender,
  logVideoRenderEvent,
} from "@/lib/video-render-queue";
import { getSetting, getStory } from "@/lib/repo";
import {
  isVideoAspect,
  LEGACY_DEFAULT_ASPECT,
  type VideoAspect,
} from "@/lib/aspect";
import { resolveSegmentsForStory } from "@/lib/segment-resolver";
import { rewriteStoredMediaUrlsDeep } from "@/lib/media-url";

// Override undici's 300s default headers/body timeouts. Cloud Run
// renders a 2:11 envelope-style composition in ~3-7 minutes (cold
// start + Chromium boot + 3936-frame render + GCS upload), so anything
// under ~10 min causes the fetch to abort before the response comes
// back. Vercel Pro's 800s function cap gives us headroom; this
// agent's 900s is intentionally past it so the cron's own deadline
// wins instead of undici truncating mid-render.
const longRunAgent = new Agent({
  headersTimeout: 900_000,
  bodyTimeout: 900_000,
  keepAliveTimeout: 60_000,
});

// Vercel Pro cron functions get up to 800s. We leave 30s headroom for
// the response write + Cloud Run's last-mile latency. The fetch below
// uses AbortSignal.timeout(DEADLINE_MS) to make the wait explicit.
const DEADLINE_MS = 770_000;

// Single source of truth for the JSON contract with Cloud Run. The
// service's server/index.ts is the OTHER end; keeping the shape in
// one place here means a contract change has a grepable single home.
interface CloudRunRenderResponse {
  url?: unknown;
  error?: unknown;
}

/** Resolved intro/outro URLs the cron picked for this render. Passed
 *  verbatim to Cloud Run as the `segments` field on the /render body.
 *  Phase 4 of _plans/2026-06-15-cloud-run-intro-outro-splice.md. */
interface CloudRunSegments {
  intro: string | null;
  outro: string | null;
  /** Seconds of held-frame + silent-audio pad inserted on the body's
   *  tail when an outro is present. Mirrors the
   *  `outro_lead_in_sec` plumbing on the local pipeline (Python
   *  `pipeline/segments.py:splice`). Cloud Run reads this off the
   *  splice request body; null = no pad, keep the splice byte-equivalent
   *  to the pre-fix behaviour. */
  outroLeadInSec?: number;
}

/** Default silent gap between body and outro, in milliseconds. Tunable
 *  via the `video.outro_lead_in_ms` setting; mirrors the Python default
 *  in pipeline/segments.py:DEFAULT_OUTRO_LEAD_IN_MS. */
const DEFAULT_OUTRO_LEAD_IN_MS = 1500;

/** Read `video.outro_lead_in_ms` and return seconds clamped to a sane
 *  range. Defaults to DEFAULT_OUTRO_LEAD_IN_MS when unset or
 *  unparseable so a typo doesn't fail the render. */
async function resolveOutroLeadInSec(): Promise<number> {
  const raw = (await getSetting("video.outro_lead_in_ms")) ?? "";
  const trimmed = raw.trim();
  const ms = trimmed === "" ? DEFAULT_OUTRO_LEAD_IN_MS : Number(trimmed);
  if (!Number.isFinite(ms)) return DEFAULT_OUTRO_LEAD_IN_MS / 1000;
  return Math.max(0, Math.min(10_000, ms)) / 1000;
}

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[dispatch_video_render ${event}]`, JSON.stringify(fields));
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
  // AbortSignal.timeout is the modern + portable way to cap a fetch.
  // We log both the network outcome AND the body shape because Cloud
  // Run returning a 200 with a malformed body is the most confusing
  // failure mode to diagnose without the body fields in the log.
  try {
    // Use undici directly (not the global fetch) so we control the
    // headersTimeout / bodyTimeout. The global fetch defaults to 300s
    // headers timeout which truncates ~5 min renders.
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

  const claimed = await claimNextRender();
  if (!claimed) {
    namespacedLog("idle", {});
    return NextResponse.json({ drained: 0 });
  }

  namespacedLog("claimed", {
    render_id: claimed.id,
    story_id: claimed.story_id,
    config_hash: claimed.config_hash.slice(0, 12),
  });

  // Load the story's persisted video_config — this is the same JSON
  // blob the local pipeline/render_worker.py reads + writes, and the
  // editor's PreviewComposition reads to drive its inline player. The
  // Remotion `Composition` in video/src/Root.tsx accepts the shape
  // directly via the `inputProps` arg (matching what `npx remotion
  // render --props=...` does for the local renderer).
  //
  // Three failure modes handled inline because they're row-specific
  // (NOT cron-config issues — the cron itself is healthy):
  //   - story row not found → likely a manual DB delete; fail the
  //     render so the orchestrator gives up and the queue moves on.
  //   - video_config missing → story never rendered; can't proceed.
  //   - video_config malformed JSON → corrupt row; fail clearly.
  const story = await getStory(claimed.story_id);
  if (!story) {
    const err = `story ${claimed.story_id} not found`;
    namespacedLog("story_missing", {
      render_id: claimed.id,
      story_id: claimed.story_id,
    });
    await logVideoRenderEvent(claimed.id, "story_missing", {
      level: "error",
      message: err,
    });
    await failRender(claimed.id, err);
    return NextResponse.json({
      drained: 1,
      render_id: claimed.id,
      status: "error",
      error: err,
    });
  }
  if (!story.video_config) {
    const err =
      `story ${claimed.story_id} has no video_config — run a local ` +
      `pipeline render first to seed it`;
    namespacedLog("config_missing", {
      render_id: claimed.id,
      story_id: claimed.story_id,
    });
    await logVideoRenderEvent(claimed.id, "config_missing", {
      level: "error",
      message: err,
    });
    await failRender(claimed.id, err);
    return NextResponse.json({
      drained: 1,
      render_id: claimed.id,
      status: "error",
      error: err,
    });
  }
  let inputProps: unknown;
  try {
    inputProps = JSON.parse(story.video_config);
  } catch (e) {
    const err = `video_config not valid JSON: ${
      e instanceof Error ? e.message : String(e)
    }`;
    namespacedLog("config_malformed", {
      render_id: claimed.id,
      story_id: claimed.story_id,
      error: err,
    });
    await logVideoRenderEvent(claimed.id, "config_malformed", {
      level: "error",
      message: err,
    });
    await failRender(claimed.id, err);
    return NextResponse.json({
      drained: 1,
      render_id: claimed.id,
      status: "error",
      error: err,
    });
  }

  // Phase 4 of _plans/2026-06-15-cloud-run-intro-outro-splice.md.
  // Resolve which intro / outro segment to splice for this story so
  // Cloud Run can stitch them around the body. The TS resolver mirrors
  // pipeline/segments.py:pick_segment exactly — skip flag wins, then
  // story-pinned id, then global master switch, then global active id,
  // with an aspect filter at the bottom that drops a segment whose
  // shape doesn't match the story's resolved aspect. A failure here is
  // recoverable: we log + fall through with {intro: null, outro: null}
  // so the render still produces a body-only MP4 instead of failing
  // the whole row over a missing segment row.
  const segments = await resolveSegmentsSafe(claimed.id, story);
  // Tail-pad between body and outro so the narrator's last word isn't
  // stepped on. Resolved from the same setting as the local-pipeline
  // path so a single knob ("video.outro_lead_in_ms") controls both.
  if (segments.outro !== null) {
    segments.outroLeadInSec = await resolveOutroLeadInSec();
  }
  await logVideoRenderEvent(claimed.id, "segments_resolved", {
    message: "Resolved intro/outro for this render.",
    payload: {
      intro_url: segments.intro,
      outro_url: segments.outro,
      outro_lead_in_sec: segments.outroLeadInSec ?? 0,
    },
  });
  namespacedLog("segments_resolved", {
    render_id: claimed.id,
    story_id: claimed.story_id,
    has_intro: segments.intro !== null,
    has_outro: segments.outro !== null,
    outro_lead_in_sec: segments.outroLeadInSec ?? 0,
  });

  // Walk inputProps + segments and rewrite any persisted legacy GCS URLs
  // onto MEDIA_PUBLIC_BASE before they cross out to Cloud Run. Same rationale
  // as render_short: Cloud Run's Remotion render fetches every URL via HTTP,
  // and legacy GCS public reads 404 post-2026-06-22 migration. Inert when the
  // base is unset. Plan:
  // _plans/2026-06-23-pipeline-outbound-url-rewriter.md.
  const propsRewrote = rewriteStoredMediaUrlsDeep(inputProps);
  const segmentsRewrote = rewriteStoredMediaUrlsDeep(segments);
  namespacedLog("rewrite", {
    render_id: claimed.id,
    props_rewrote: propsRewrote,
    segments_rewrote: segmentsRewrote,
  });

  await logVideoRenderEvent(claimed.id, "dispatch_start", {
    message: "Posting render request to Cloud Run.",
    payload: { cloud_run_url: cloudRunUrl },
  });

  const result = await postToCloudRun(
    `${cloudRunUrl.replace(/\/$/, "")}/render`,
    {
      storyId: claimed.story_id,
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
    await logVideoRenderEvent(claimed.id, "cloud_run_failure", {
      level: "error",
      message: result.error,
    });
    await failRender(claimed.id, result.error);
    // Return 200 — Vercel cron retries on 5xx, and we don't want a
    // retry to enqueue a duplicate render. The row is already
    // recorded as errored; the next cron tick picks up a different
    // queued row if any.
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
  });
  await logVideoRenderEvent(claimed.id, "cloud_run_response", {
    message: "Cloud Run finished. Writing video_url onto the story.",
    payload: { url: result.url },
  });
  await finishRender(claimed.id, claimed.story_id, result.url);
  return NextResponse.json({
    drained: 1,
    render_id: claimed.id,
    status: "done",
    url: result.url,
  });
}

/** Resolve intro/outro for this story with a defensive fallback to
 *  {intro: null, outro: null} on any error so a missing-segment row
 *  or a setting-fetch hiccup degrades to a body-only render instead of
 *  killing the whole queue row. Errors are logged + emitted to the
 *  render history so the admin can see what went wrong.
 *
 *  The story is typed as the row coming out of getStory(); the
 *  resolver only reads the four intro/outro columns + video_config so
 *  passing the whole row is fine. */
async function resolveSegmentsSafe(
  renderId: string,
  story: Awaited<ReturnType<typeof getStory>>,
): Promise<CloudRunSegments> {
  if (!story) return { intro: null, outro: null };
  try {
    const rawAspect = await getSetting("video.default_aspect");
    const globalDefaultAspect: VideoAspect = isVideoAspect(rawAspect)
      ? rawAspect
      : LEGACY_DEFAULT_ASPECT;
    const resolved = await resolveSegmentsForStory(story, globalDefaultAspect);
    return {
      intro: resolved.intro.segment?.normalized_url ?? null,
      outro: resolved.outro.segment?.normalized_url ?? null,
    };
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    namespacedLog("segments_resolve_failed", { render_id: renderId, error: msg });
    await logVideoRenderEvent(renderId, "segments_resolve_failed", {
      level: "warn",
      message: msg,
    });
    return { intro: null, outro: null };
  }
}

// App Router's route handler shape — both GET (cron pings) and POST
// (manual kick) wire to the same internal serve(). Vercel cron calls
// GET by default.
export async function GET(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

// Increase the maxDuration to the Pro plan's ceiling so Vercel doesn't
// kill us at 60s. The cron itself is configured via vercel.json with
// the same value. Type assertion because Next's exported constants
// type doesn't include this field in some versions.
export const maxDuration = 800;
