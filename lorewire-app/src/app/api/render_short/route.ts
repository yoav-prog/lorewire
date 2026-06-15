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

// A short runs kie image generation + Remotion render, the longest job in the
// app, so override undici's 300s default timeouts. Vercel Pro's 800s cron cap is
// the real ceiling; 900s here lets the cron deadline win over undici.
const longRunAgent = new Agent({
  headersTimeout: 900_000,
  bodyTimeout: 900_000,
  keepAliveTimeout: 60_000,
});

const DEADLINE_MS = 770_000;

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

  const result = await postToCloudRun(
    `${cloudRunUrl.replace(/\/$/, "")}/render`,
    {
      storyId: claimed.story_id,
      configHash: claimed.config_hash,
      inputProps,
      segments: { intro: null, outro: null },
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
  });
  await finishShortRender(claimed.id, result.url);
  return NextResponse.json({
    drained: 1,
    render_id: claimed.id,
    status: "done",
    url: result.url,
  });
}

// Vercel cron calls GET; POST is a manual kick. Both wire to serve().
export async function GET(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export const maxDuration = 800;
