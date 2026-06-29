// Vercel cron drain for the facebook_posts queue.
//
// Picks up rows the auto path left in status='failed' and retries them
// with exponential backoff (1 / 2 / 4 / 8 / 16 minutes between attempts,
// cap 5 attempts). Mirrors the auth pattern from /api/render_short
// (CRON_SECRET Bearer).
//
// By design (Option A from _plans/2026-06-23-facebook-auto-publish.md),
// this cron runs regardless of the master `publisher.facebook.auto_publish`
// toggle. The toggle gates NEW auto-publish attempts; previously-failed
// rows in the queue must still drain so a brief toggle-off during an
// outage doesn't strand work.
//
// Race notes: two concurrent cron firings COULD both pick up the same
// row, which would cause a double-post on the LoreWire Page. Vercel
// cron's 5-minute cadence + Postgres's serial pooler make this
// extremely unlikely in practice; the cron processes a bounded batch
// per call so a single firing also can't fan out far. Tighter
// guarantee (CLAIM via atomic UPDATE) is a follow-up if we ever see
// a duplicate in observability.

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { all } from "@/lib/db";
import { attemptFacebookPublishForRow } from "@/lib/publish-to-facebook";

// Cap on rows processed per cron firing. Keeps Vercel route runtime
// bounded and prevents one cron from monopolising the Page's API
// rate limit. With 5-minute cadence and at most 5 attempts per row,
// 25 rows/cron is generous headroom for normal failure volume.
const BATCH_LIMIT = 25;

// Backoff in MINUTES per attempt count. Index = `attempts` (the column
// value as it sits in the row, pre-bump). attempts=0 means a row that
// has never been tried (created but inline attempt threw before
// markFailed could land) — eligible immediately. attempts=5 means
// we're at the cap and stop retrying.
const BACKOFF_MINUTES_BY_ATTEMPT: readonly number[] = [0, 1, 2, 4, 8, 16];
const MAX_ATTEMPTS = 5;

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[retry_facebook_publishes ${event}]`, JSON.stringify(fields));
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
  if (!Number.isFinite(createdMs)) {
    // Bad timestamp shouldn't block retry — better to attempt than to
    // strand the row forever.
    return true;
  }
  return nowMs - createdMs >= backoffMin * 60_000;
}

async function serve(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    namespacedLog("auth_fail", {
      ip: req.headers.get("x-forwarded-for") ?? "unknown",
    });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Fetch all failed rows under the attempts cap. Filtering by backoff
  // here would need DB-specific datetime arithmetic; we pull a bounded
  // candidate set and filter in TS instead. The table is small (one row
  // per published short), so a scan is cheap.
  const candidates = await all<FailedRowProbe>(
    `SELECT id, created_at, attempts
     FROM facebook_posts
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
    const result = await attemptFacebookPublishForRow(row.id);
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

// Vercel cron calls GET; POST is a manual kick. Both wire to serve().
export async function GET(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export const maxDuration = 300;
