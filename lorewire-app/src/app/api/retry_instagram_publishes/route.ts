// Vercel cron drain for the instagram_posts queue.
//
// Mirrors /api/retry_facebook_publishes. Two differences for IG:
//   1. Eligibility includes status='pending' rows with a container_id —
//      those aren't "failed", they're "container created but still
//      IN_PROGRESS on IG's side when our inline budget expired."
//      attemptInstagramPublishForRow resumes polling from the stored
//      container_id without re-creating, so the 100/24h post quota isn't
//      wasted on orphan containers.
//   2. Pending rows skip the backoff filter (they're not failures; the
//      retry cron is the designated finisher). Failed rows still get
//      exponential backoff (1/2/4/8/16 min, cap 5 attempts).
//
// Plan: _plans/2026-06-24-instagram-auto-publish.md.

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { all } from "@/lib/db";
import { attemptInstagramPublishForRow } from "@/lib/publish-to-instagram";

const BATCH_LIMIT = 25;
const BACKOFF_MINUTES_BY_ATTEMPT: readonly number[] = [0, 1, 2, 4, 8, 16];
const MAX_ATTEMPTS = 5;

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(
    `[retry_instagram_publishes ${event}]`,
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

interface IgRowProbe {
  id: string;
  status: string;
  created_at: string;
  attempts: number | string | null;
  container_id: string | null;
}

/** Pure: decide whether a row is eligible for retry. Failed rows
 *  observe exponential backoff; pending rows with a container_id are
 *  always eligible (they're awaiting publish, not retrying a failure).
 *  Exported for unit tests. */
export function isEligibleForRetry(
  status: string,
  attempts: number,
  createdAtIso: string,
  containerId: string | null,
  nowMs: number,
): boolean {
  if (attempts >= MAX_ATTEMPTS) return false;
  // Pending with container = resume publish, no backoff
  if (status === "pending" && containerId) return true;
  // Failed = exponential backoff
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

  // Fetch both failed and pending(with-container) candidates. Filter in
  // TS for portable datetime arithmetic across SQLite + Postgres.
  const candidates = await all<IgRowProbe>(
    `SELECT id, status, created_at, attempts, container_id
     FROM instagram_posts
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
    const result = await attemptInstagramPublishForRow(row.id);
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
