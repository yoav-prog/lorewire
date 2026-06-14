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
import {
  claimNextRender,
  failRender,
  finishRender,
} from "@/lib/video-render-queue";

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
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEADLINE_MS),
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

  // The Cloud Run server expects { storyId, configHash, inputProps }.
  // For Phase 2 the inputProps is just an empty object placeholder —
  // Phase 3 wires the actual config-to-props translation (mirroring
  // pipeline/video.py:generate_video's prop bag).
  const result = await postToCloudRun(
    `${cloudRunUrl.replace(/\/$/, "")}/render`,
    {
      storyId: claimed.story_id,
      configHash: claimed.config_hash,
      inputProps: {},
    },
    cronSecret,
  );

  if (!result.ok) {
    namespacedLog("failed", {
      render_id: claimed.id,
      story_id: claimed.story_id,
      error: result.error,
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
  await finishRender(claimed.id, claimed.story_id, result.url);
  return NextResponse.json({
    drained: 1,
    render_id: claimed.id,
    status: "done",
    url: result.url,
  });
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
