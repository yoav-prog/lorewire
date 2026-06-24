// Vercel cron drain for the instagram_stories queue.
//
// Mirrors /api/retry_instagram_publishes. Same two eligibility classes:
//   1. status='failed' rows under MAX_ATTEMPTS, with exponential backoff
//      (1/2/4/8/16 min).
//   2. status='pending' rows with a container_id set — those aren't
//      failures, they're "container created but still IN_PROGRESS on
//      IG's side when our inline budget expired." Resume polling +
//      publish without re-creating the container (would burn the
//      100/24h quota and orphan one).
//
// Plan: _plans/2026-06-25-instagram-facebook-stories-cross-publish.md.

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { all } from "@/lib/db";
import { attemptInstagramStoryPublishForRow } from "@/lib/publish-to-instagram-story";

const BATCH_LIMIT = 25;
const BACKOFF_MINUTES_BY_ATTEMPT: readonly number[] = [0, 1, 2, 4, 8, 16];
const MAX_ATTEMPTS = 5;

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(
    `[retry_instagram_stories ${event}]`,
    JSON.stringify(fields),
  );
}

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  return header === `Bearer ${expected}`;
}

interface IgStoryRowProbe {
  id: string;
  status: string;
  created_at: string;
  attempts: number | string | null;
  container_id: string | null;
}

export function isEligibleForRetry(
  status: string,
  attempts: number,
  createdAtIso: string,
  containerId: string | null,
  nowMs: number,
): boolean {
  if (attempts >= MAX_ATTEMPTS) return false;
  if (status === "pending" && containerId) return true;
  if (status !== "failed") return false;
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

  const candidates = await all<IgStoryRowProbe>(
    `SELECT id, status, created_at, attempts, container_id
     FROM instagram_stories
     WHERE COALESCE(attempts, 0) < ?
       AND (
         status = 'failed'
         OR (status = 'pending' AND container_id IS NOT NULL)
       )
     ORDER BY created_at ASC
     LIMIT ?`,
    [MAX_ATTEMPTS, BATCH_LIMIT * 2],
  );

  const nowMs = Date.now();
  const eligible = candidates
    .filter((r) =>
      isEligibleForRetry(
        r.status,
        Number(r.attempts ?? 0),
        r.created_at,
        r.container_id,
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
  let stillPending = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of eligible) {
    const result = await attemptInstagramStoryPublishForRow(row.id);
    if (result.status === "posted") posted += 1;
    else if (result.status === "pending") stillPending += 1;
    else if (result.status === "failed") failed += 1;
    else skipped += 1;
  }

  namespacedLog("done", {
    drained: eligible.length,
    posted,
    still_pending: stillPending,
    failed,
    skipped,
  });

  return NextResponse.json({
    drained: eligible.length,
    posted,
    still_pending: stillPending,
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
