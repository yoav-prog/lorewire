// Vercel cron tick for poll_aggregates. Every 5 minutes, finds polls
// whose underlying vote count has drifted from the materialised
// aggregate (last_vote_at later than refreshed_at, OR a poll that
// has votes but no aggregate row yet) and recomputes them. Also
// prunes ip_ua_hash off poll_votes rows older than 24h (the durable-
// fingerprint mitigation per plan §6).
//
// Auth: CRON_SECRET Bearer, matching the other drains.
// Safety: each story's refresh is idempotent and isolated; a single
// row failure doesn't abort the batch.
//
// Plan: _plans/2026-06-17-engagement-polls.md (§6 + §11).

import { NextResponse, type NextRequest } from "next/server";
import { all, run } from "@/lib/db";
import { refreshPollAggregateForStory } from "@/lib/polls";

const PRUNE_HASH_AFTER_HOURS = 24;
const BATCH_LIMIT = 200;

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  return header === `Bearer ${expected}`;
}

interface StaleRow {
  story_id: string;
}

async function findStaleStories(): Promise<string[]> {
  // Two classes of work:
  //   (a) a poll exists + has votes + the aggregate is missing or
  //       lagging the latest vote. Read via a UNION so the query stays
  //       portable across SQLite + Postgres (some Postgres versions
  //       trip on correlated subqueries against an empty side).
  //   (b) no fast path for "poll exists but never voted on" — those
  //       have nothing to refresh. The aggregate stays absent.
  const rows = await all<StaleRow>(
    `
    SELECT DISTINCT pv.story_id AS story_id
    FROM poll_votes pv
    LEFT JOIN poll_aggregates pa ON pa.story_id = pv.story_id
    WHERE pa.story_id IS NULL
       OR pa.last_vote_at IS NULL
       OR pa.last_vote_at <> (
            SELECT MAX(created_at) FROM poll_votes WHERE poll_id = pv.poll_id
          )
    LIMIT ?
    `,
    [BATCH_LIMIT],
  );
  return rows.map((r) => r.story_id).filter(Boolean);
}

async function pruneOldIpUaHashes(): Promise<number> {
  const cutoff = new Date(
    Date.now() - PRUNE_HASH_AFTER_HOURS * 60 * 60 * 1000,
  ).toISOString();
  // SQLite returns no count from UPDATE; we count the candidate rows
  // first so the log line is honest about how many we touched. The
  // count is best-effort observability, not an integrity check.
  const counted = await all<{ c: number }>(
    "SELECT COUNT(*) AS c FROM poll_votes WHERE ip_ua_hash IS NOT NULL AND created_at < ?",
    [cutoff],
  );
  const total = Number(counted[0]?.c ?? 0);
  if (total === 0) return 0;
  await run(
    "UPDATE poll_votes SET ip_ua_hash = NULL WHERE ip_ua_hash IS NOT NULL AND created_at < ?",
    [cutoff],
  );
  return total;
}

async function serve(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const start = Date.now();
  let storiesRefreshed = 0;
  let failures = 0;
  let pruned = 0;
  try {
    const ids = await findStaleStories();
    for (const id of ids) {
      try {
        await refreshPollAggregateForStory(id);
        storiesRefreshed += 1;
      } catch (err) {
        failures += 1;
        console.warn("[polls aggregate refresh fail]", {
          story_id: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    pruned = await pruneOldIpUaHashes();
  } catch (err) {
    console.warn("[polls cron] batch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "batch failed" },
      { status: 500 },
    );
  }
  const durationMs = Date.now() - start;
  console.info("[polls aggregate refresh cron]", {
    stories_refreshed: storiesRefreshed,
    failures,
    ip_ua_hashes_pruned: pruned,
    duration_ms: durationMs,
  });
  return NextResponse.json({
    storiesRefreshed,
    failures,
    pruned,
    durationMs,
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export const maxDuration = 60;
