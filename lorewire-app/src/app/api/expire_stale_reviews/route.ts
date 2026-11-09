// Vercel cron: garbage-collect stale review items for the Render
// Scheduler.
//
// Auto-rendered stories that no human approves would otherwise pile up in
// `review` forever, filling the queue and (through the render
// backpressure gate) stalling fresh rendering. This hourly pass archives
// scheduler-created stories that have sat in review past the freshness
// TTL. It only ever touches stories the scheduler itself enqueued, never
// a review item a human made or is holding on purpose.
//
// Auth: CRON_SECRET Bearer, like every other cron.
//
// Plan: _plans/2026-07-01-render-and-publish-schedulers.md.

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { expireStaleReviews } from "@/lib/render-scheduler";

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[expire_stale_reviews ${event}]`, JSON.stringify(fields));
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

  const result = await expireStaleReviews();

  namespacedLog("done", {
    expired: result.expired,
    cutoff: result.cutoff,
    ids: result.ids.slice(0, 25),
  });

  return NextResponse.json({ expired: result.expired, cutoff: result.cutoff });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export const maxDuration = 60;
