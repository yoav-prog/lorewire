// Vercel cron drain for the tiktok_posts queue.
//
// Picks up rows the auto path left in status='failed' OR 'pending' with
// a publish_id (the inline 30s poll timed out mid-flight; we resume
// polling here). Mirrors retry_instagram_publishes which uses the same
// pattern for IG's container-status flow.
//
// Backoff is the same exponential ladder as the other publishers
// (1 / 2 / 4 / 8 / 16 minutes, cap 5 attempts). For pending rows we
// don't gate on backoff at all — they're mid-flight and we want to
// drain them as soon as possible.
//
// Plan: _plans/2026-06-24-youtube-and-tiktok-auto-publish-and-socials-admin.md.

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { all } from "@/lib/db";
import { attemptTikTokPublishForRow } from "@/lib/publish-to-tiktok";

const BATCH_LIMIT = 25;
const BACKOFF_MINUTES_BY_ATTEMPT: readonly number[] = [0, 1, 2, 4, 8, 16];
const MAX_ATTEMPTS = 5;

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[retry_tiktok_publishes ${event}]`, JSON.stringify(fields));
}

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  return header === `Bearer ${expected}`;
}

interface CandidateRowProbe {
  id: string;
  status: string;
  publish_id: string | null;
  created_at: string;
  attempts: number | string | null;
}

/** Pure: decide whether a row's backoff window has elapsed. Pending
 *  rows are eligible immediately so the cron drains them on the next
 *  tick (TikTok's async pipeline frequently takes >30s for the inline
 *  poll). Failed rows follow the exponential ladder. */
export function isEligibleForRetry(
  status: string,
  publishId: string | null,
  attempts: number,
  createdAtIso: string,
  nowMs: number,
): boolean {
  if (attempts >= MAX_ATTEMPTS) return false;
  if (status === "pending" && publishId) return true;
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

  const candidates = await all<CandidateRowProbe>(
    `SELECT id, status, publish_id, created_at, attempts
     FROM tiktok_posts
     WHERE (status = 'failed' OR (status = 'pending' AND publish_id IS NOT NULL))
       AND COALESCE(attempts, 0) < ?
     ORDER BY created_at ASC
     LIMIT ?`,
    [MAX_ATTEMPTS, BATCH_LIMIT * 2],
  );

  const nowMs = Date.now();
  const eligible = candidates
    .filter((r) =>
      isEligibleForRetry(
        r.status,
        r.publish_id,
        Number(r.attempts ?? 0),
        r.created_at,
        nowMs,
      ),
    )
    .slice(0, BATCH_LIMIT);

  namespacedLog("scan", {
    candidates: candidates.length,
    eligible: eligible.length,
    cap: BATCH_LIMIT,
  });

  let posted = 0;
  let pending = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of eligible) {
    const result = await attemptTikTokPublishForRow(row.id);
    if (result.status === "posted") posted += 1;
    else if (result.status === "pending") pending += 1;
    else if (result.status === "failed") failed += 1;
    else skipped += 1;
  }

  namespacedLog("done", {
    drained: eligible.length,
    posted,
    pending,
    failed,
    skipped,
  });

  return NextResponse.json({
    drained: eligible.length,
    posted,
    pending,
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

export const maxDuration = 300;
