// Vercel cron for the Render Scheduler drip.
//
// Each firing runs one rate-limited tick: if the backpressure gate is
// open and the token bucket has whole credits, it selects the highest
// priority eligible Reddit sources and enqueues them into story_jobs via
// the same path the manual "Process N" uses. The Python worker
// (drain_story_jobs) then renders them; they land in `review` for a
// human to approve. All the throttling lives in runRenderDrip; this
// route is just auth + invoke + structured log.
//
// Auth: CRON_SECRET Bearer, same as every other cron. The gate's own
// kill switch (render.enabled, default off) means a misconfigured deploy
// never auto-renders until an admin opts in.
//
// Plan: _plans/2026-07-01-render-and-publish-schedulers.md.

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { runRenderDrip } from "@/lib/render-scheduler";

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[render_enqueue ${event}]`, JSON.stringify(fields));
}

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  return header === `Bearer ${expected}`;
}

async function serve(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    namespacedLog("auth_fail", {
      ip: req.headers.get("x-forwarded-for") ?? "unknown",
    });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await runRenderDrip();

  namespacedLog("tick", {
    enqueued: result.enqueued,
    reason: result.reason,
    gate_reason: result.gate.reason,
    review_depth: result.gate.reviewDepth,
    review_cap: result.gate.reviewQueueCap,
    allowance: result.allowance,
    headroom: result.headroom,
  });

  return NextResponse.json({
    enqueued: result.enqueued,
    reason: result.reason,
    gate: result.gate.reason,
    allowance: result.allowance,
    headroom: result.headroom,
  });
}

// Vercel cron calls GET; POST is a manual kick from the admin UI / tests.
export async function GET(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export const maxDuration = 60;
