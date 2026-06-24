// Vercel cron drain for the youtube_posts queue.
//
// Picks up rows the auto path left in status='failed' and retries them
// with exponential backoff (1 / 2 / 4 / 8 / 16 minutes between attempts,
// cap 5 attempts). Mirrors retry_facebook_publishes.
//
// By design (Option A from the FB plan, carried forward into YouTube),
// this cron runs regardless of the master `publisher.youtube.auto_publish`
// toggle. The toggle gates NEW auto-publish attempts; previously-failed
// rows must still drain so a brief toggle-off during an outage doesn't
// strand work.
//
// Plan: _plans/2026-06-24-youtube-and-tiktok-auto-publish-and-socials-admin.md.

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { all } from "@/lib/db";
import { attemptYouTubePublishForRow } from "@/lib/publish-to-youtube";

const BATCH_LIMIT = 25;
const BACKOFF_MINUTES_BY_ATTEMPT: readonly number[] = [0, 1, 2, 4, 8, 16];
const MAX_ATTEMPTS = 5;

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[retry_youtube_publishes ${event}]`, JSON.stringify(fields));
}

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  return header === `Bearer ${expected}`;
}

interface FailedRowProbe {
  id: string;
  created_at: string;
  attempts: number | string | null;
}

/** Pure: decide whether a failed row's backoff window has elapsed.
 *  Exported for unit tests. */
export function isEligibleForRetry(
  attempts: number,
  createdAtIso: string,
  nowMs: number,
): boolean {
  if (attempts >= MAX_ATTEMPTS) return false;
  const backoffMin = BACKOFF_MINUTES_BY_ATTEMPT[attempts] ?? 0;
  const createdMs = Date.parse(createdAtIso);
  if (!Number.isFinite(createdMs)) return true;
  return nowMs - createdMs >= backoffMin * 60_000;
}

async function serve(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    namespacedLog("auth_fail", {
      ip: req.headers.get("x-forwarded-for") ?? "unknown",
    });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const candidates = await all<FailedRowProbe>(
    `SELECT id, created_at, attempts
     FROM youtube_posts
     WHERE status = 'failed' AND COALESCE(attempts, 0) < ?
     ORDER BY created_at ASC
     LIMIT ?`,
    [MAX_ATTEMPTS, BATCH_LIMIT * 2],
  );

  const nowMs = Date.now();
  const eligible = candidates
    .filter((r) =>
      isEligibleForRetry(Number(r.attempts ?? 0), r.created_at, nowMs),
    )
    .slice(0, BATCH_LIMIT);

  namespacedLog("scan", {
    candidates: candidates.length,
    eligible: eligible.length,
    cap: BATCH_LIMIT,
  });

  let posted = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of eligible) {
    const result = await attemptYouTubePublishForRow(row.id);
    if (result.status === "posted") posted += 1;
    else if (result.status === "failed") failed += 1;
    else skipped += 1;
  }

  namespacedLog("done", {
    drained: eligible.length,
    posted,
    failed,
    skipped,
  });

  return NextResponse.json({
    drained: eligible.length,
    posted,
    failed,
    skipped,
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

// YouTube's resumable upload is the slow step (download MP4 + PUT
// bytes); 300s is enough for the BATCH_LIMIT of 25 with normal-sized
// shorts.
export const maxDuration = 300;
