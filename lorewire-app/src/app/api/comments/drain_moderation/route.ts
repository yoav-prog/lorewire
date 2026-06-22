// Vercel cron retry net for comment moderation. Inline moderation on POST fails
// closed to a 'held'/'timeout' (or 'pending') state when the Moderation API or
// the judge is slow; this tick re-runs those so a provider blip never buries a
// comment that the author can see is "pending review". It does NOT touch
// comments a judge deliberately held for a human (their source is a verdict,
// not 'pending'/'timeout'). Also prunes ip_ua_hash off comments older than 24h,
// the same durable-fingerprint mitigation the poll cron applies.
//
// Auth: CRON_SECRET Bearer, matching the other drains.
// Safety: each comment is isolated; one failure doesn't abort the batch. A
// comment that still times out stays in the set and is retried next tick.
//
// Plan: _plans/2026-06-22-article-comments-ai-moderation.md (Step 4).

import { NextResponse, type NextRequest } from "next/server";
import { all, run } from "@/lib/db";
import { getArticle } from "@/lib/repo";
import { listStaleModerationComments, setCommentStatus } from "@/lib/comments";
import { moderateComment } from "@/lib/comment-moderation";

const BATCH_LIMIT = 50;
const PRUNE_HASH_AFTER_HOURS = 24;

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  return header === `Bearer ${expected}`;
}

async function pruneOldIpUaHashes(): Promise<number> {
  const cutoff = new Date(
    Date.now() - PRUNE_HASH_AFTER_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const counted = await all<{ c: number }>(
    "SELECT COUNT(*) AS c FROM comments WHERE ip_ua_hash IS NOT NULL AND created_at < ?",
    [cutoff],
  );
  const total = Number(counted[0]?.c ?? 0);
  if (total === 0) return 0;
  await run(
    "UPDATE comments SET ip_ua_hash = NULL WHERE ip_ua_hash IS NOT NULL AND created_at < ?",
    [cutoff],
  );
  return total;
}

async function serve(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const start = Date.now();
  let processed = 0;
  let failures = 0;
  let pruned = 0;
  try {
    const stale = await listStaleModerationComments(BATCH_LIMIT);
    for (const c of stale) {
      try {
        const article = await getArticle(c.article_id);
        const verdict = await moderateComment({
          body: c.body,
          lang: c.lang ?? "en",
          articleTitle: article?.title ?? "",
          articleSummary: article?.summary ?? "",
        });
        await setCommentStatus(
          c.id,
          verdict.status,
          {
            source: verdict.source,
            category: verdict.category,
            reason: verdict.reason,
            confidence: verdict.confidence,
            stance: verdict.stance,
            sentiment: verdict.sentiment,
            topicTag: verdict.topicTag,
          },
          "ai",
        );
        processed += 1;
      } catch (err) {
        failures += 1;
        console.warn("[comments drain] item failed", {
          comment_id: c.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    pruned = await pruneOldIpUaHashes();
  } catch (err) {
    console.warn("[comments drain] batch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "batch failed" }, { status: 500 });
  }
  const durationMs = Date.now() - start;
  console.info("[comments moderation drain cron]", {
    processed,
    failures,
    ip_ua_hashes_pruned: pruned,
    duration_ms: durationMs,
  });
  return NextResponse.json({ processed, failures, pruned, durationMs });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export const maxDuration = 60;
