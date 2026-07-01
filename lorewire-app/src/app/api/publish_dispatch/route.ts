// Vercel cron (per-minute) for the Publish Scheduler dispatcher.
//
// Fires the scheduled social posts whose slot time has arrived. All the
// claiming, publishing, and idempotency lives in dispatchDuePublishes;
// this route is auth + invoke + structured log. Runs every minute so a
// slot at 09:00 fires within 09:00-09:01.
//
// Auth: CRON_SECRET Bearer, same as every other cron. The global publish
// kill switch (publish.enabled, default off) means a misconfigured deploy
// never posts until an admin opts in.
//
// Plan: _plans/2026-07-01-render-and-publish-schedulers.md.

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { dispatchDuePublishes } from "@/lib/publish-dispatch";

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[publish_dispatch ${event}]`, JSON.stringify(fields));
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

  const result = await dispatchDuePublishes();

  namespacedLog("tick", { ...result });

  return NextResponse.json(result);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export const maxDuration = 300;
