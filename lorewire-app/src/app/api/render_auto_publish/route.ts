// Vercel cron for the Render Scheduler auto-publish lane.
//
// Each firing runs one auto-publish tick: when render.auto_publish is on, it
// screens the ready render-scheduler stories waiting in review and publishes
// the clean ones through the same gate + scheduler a human Approve uses. All
// the gating (toggle, safety judge, asset gate, gate-refusal ladder, circuit
// breaker) lives in lib/render-auto-publish.ts; this route is just auth +
// invoke + structured log.
//
// Auth: CRON_SECRET Bearer, same as every other cron. The lane's own toggle
// (render.auto_publish, default off) means a misconfigured deploy never
// publishes anything until an admin opts in — and the circuit breaker flips
// it back off after repeated systemic failures.
//
// Plan: _plans/2026-07-12-render-scheduler-auto-publish.md.

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { runRenderSchedulerAutoPublish } from "@/lib/render-auto-publish";

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[render-autopublish ${event}]`, JSON.stringify(fields));
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

  const result = await runRenderSchedulerAutoPublish();
  namespacedLog("tick", {
    reason: result.reason,
    approved: result.approved,
    held: result.held,
    deferred: result.deferred,
    failed: result.failed,
    skipped: result.skipped,
    tripped: result.tripped,
  });

  return NextResponse.json(result);
}

// Vercel cron calls GET; POST is a manual kick from the admin UI / tests.
export async function GET(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export const maxDuration = 300;
