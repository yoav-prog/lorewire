// Vercel cron for Autopilot: one pull tick then one approve tick.
//
// Pull: when the human review queue is empty and the daily limit has
// room, enqueue STRONG-only Reddit sources (runs in shadow and live).
// Approve: in live mode only, screen each rendered autopilot story with
// the safety judge and push clean ones through the same approve path a
// human uses. All the gating lives in lib/autopilot.ts; this route is
// just auth + invoke + structured log.
//
// Auth: CRON_SECRET Bearer, same as every other cron. Autopilot's own
// mode setting (default off) means a misconfigured deploy never
// publishes anything until an admin opts in — and the circuit breaker
// flips it back off after repeated failures.
//
// Plan: _plans/2026-07-02-scheduler-autopilot-and-flexible-slots.md.

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { runAutopilotApprove, runAutopilotPull } from "@/lib/autopilot";

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[autopilot ${event}]`, JSON.stringify(fields));
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

  const pull = await runAutopilotPull();
  namespacedLog("pull", {
    reason: pull.reason,
    enqueued: pull.enqueued,
    mode: pull.mode,
    human_review_depth: pull.humanReviewDepth,
    used_today: pull.usedToday,
    daily_limit: pull.dailyLimit,
  });

  const approve = await runAutopilotApprove();
  namespacedLog("approve", {
    reason: approve.reason,
    approved: approve.approved,
    held: approve.held,
    failed: approve.failed,
    skipped: approve.skipped,
    tripped: approve.tripped,
  });

  return NextResponse.json({ pull, approve });
}

// Vercel cron calls GET; POST is a manual kick from the admin UI / tests.
export async function GET(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export const maxDuration = 300;
