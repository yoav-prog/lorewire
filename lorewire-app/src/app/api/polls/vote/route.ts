// Public POST endpoint backing the PollWidget. Reads (or issues) the
// `lw_vote` cookie, validates body shape, runs the per-instance
// rate-limit bucket, inserts the vote idempotently on
// (poll_id, cookie_token), and returns the now-current aggregate view
// — including whether the floor has been crossed — so the widget can
// flip from pre-vote to post-vote state on a single fetch round-trip.
//
// Why an API route and not a server action: the widget is a client
// island that re-renders inline on response. A server action would
// force a full route revalidation; the fetch round-trip lets us paint
// optimistically and patch with the server-confirmed numbers.
//
// 2026-06-18 standalone-article polls (plan §15): the body now
// identifies the POLL directly (`pollId`) instead of the SUBJECT
// (`storyId` only). The widget always knows the poll id (server-
// resolved during page render and passed in as a prop), so the
// route doesn't have to branch on subject kind to look it up. For
// the aggregate response: story polls read from poll_aggregates;
// article polls compute live via computeArticlePollAggregate.
//
// Security (rule 13):
//   - Origin header MUST match NEXT_PUBLIC_SITE_ORIGIN (or be the dev
//     fallback) so a cross-site script can't fire from another tab.
//   - Body is Zod-shape-validated; bad payloads → 400, never a DB write.
//   - cookie_token never returned in the response body — it only ever
//     lives in the HttpOnly cookie.
//   - ip_ua_hash on poll_votes is one-way, pruned by retention, never
//     surfaced anywhere public.
//
// Plan: _plans/2026-06-17-engagement-polls.md (§7 + §9 + §15).

import { NextResponse, type NextRequest } from "next/server";
import { getOrIssueVoteToken } from "@/lib/poll-cookie";
import {
  checkAndRecord,
  ipUaHash,
  DEFAULT_PER_HOUR,
  DEFAULT_PER_MINUTE,
} from "@/lib/poll-rate-limit";
import {
  computeArticlePollAggregate,
  DEFAULT_PUBLIC_FLOOR,
  getAggregateByStoryId,
  getPollById,
  isPollSide,
  recordVote,
  refreshPollAggregateForStory,
  toResultView,
} from "@/lib/polls";

interface VoteBody {
  pollId?: unknown;
  side?: unknown;
}

interface VoteResponseOk {
  ok: true;
  /** Did this request actually insert a vote? false when the same
   *  cookie had already voted on this poll — the client renders the
   *  post-vote state either way. */
  inserted: boolean;
  result: ReturnType<typeof toResultView>;
}

function isAllowedOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) {
    // No Origin header: fetch from a same-origin context that didn't
    // attach one (older browsers, some bots). Accept only when the
    // referer matches and we're in dev — production POSTs without
    // Origin are rejected. Vercel always sends Origin on cross-origin
    // POSTs, so this gate is the conservative default.
    return process.env.NODE_ENV !== "production";
  }
  const expected = process.env.NEXT_PUBLIC_SITE_ORIGIN?.trim() ?? "";
  if (expected) {
    return origin === expected.replace(/\/$/, "");
  }
  // No configured origin → dev fallback: localhost-only.
  if (process.env.NODE_ENV !== "production") {
    return /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
  }
  return false;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    console.warn("[polls vote origin-rejected]", {
      origin: req.headers.get("origin"),
      site_origin_set: Boolean(process.env.NEXT_PUBLIC_SITE_ORIGIN),
    });
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  let body: VoteBody;
  try {
    body = (await req.json()) as VoteBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const pollId = typeof body.pollId === "string" ? body.pollId.trim() : "";
  if (!pollId) {
    return NextResponse.json({ error: "pollId required" }, { status: 400 });
  }
  if (!isPollSide(body.side)) {
    return NextResponse.json(
      { error: "side must be 'A' or 'B'" },
      { status: 400 },
    );
  }

  // Resolve the poll BEFORE issuing a cookie — a vote on a non-existent
  // or disabled poll shouldn't pollute the client with a token. The
  // poll row carries the subject id (exactly one of story_id /
  // article_id) which we then thread into recordVote.
  const poll = await getPollById(pollId);
  if (!poll || poll.enabled !== 1) {
    return NextResponse.json({ error: "poll not available" }, { status: 404 });
  }

  // Bucket per (ip, ua). Vercel surfaces the original client IP via
  // x-forwarded-for; local dev hits 127.0.0.1 which buckets into a
  // single hash — fine.
  const ip = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")[0]
    .trim();
  const ua = req.headers.get("user-agent") ?? "";
  const hash = ipUaHash(ip || null, ua || null);
  const limit = checkAndRecord(hash);
  if (!limit.ok) {
    console.warn("[polls vote rate-limit]", {
      poll_id: pollId,
      hash_prefix: hash.slice(0, 8),
      in_minute: limit.inMinute,
      in_hour: limit.inHour,
      retry_after_sec: limit.retryAfterSec,
      per_minute: DEFAULT_PER_MINUTE,
      per_hour: DEFAULT_PER_HOUR,
    });
    return NextResponse.json(
      { error: "rate limited" },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSec) },
      },
    );
  }

  const cookieToken = await getOrIssueVoteToken();

  const result = await recordVote({
    pollId: poll.id,
    storyId: poll.story_id,
    articleId: poll.article_id,
    category: poll.category,
    side: body.side,
    cookieToken,
    ipUaHash: hash,
  });
  if (!result.ok) {
    // recordVote returns ok=false only on programmer error (missing
    // fields, bad side) — we've already validated, so this is
    // defense-in-depth.
    console.warn("[polls vote failed]", {
      poll_id: pollId,
      error: result.error,
    });
    return NextResponse.json(
      { error: result.error ?? "vote failed" },
      { status: 500 },
    );
  }

  // Aggregate response: story polls go through the persisted
  // projection (refresh inline so the post-vote percentages reveal
  // immediately); article polls compute live every time since they
  // bypass the projection table by design.
  let view: ReturnType<typeof toResultView>;
  if (poll.story_id) {
    if (result.inserted) {
      await refreshPollAggregateForStory(poll.story_id);
    }
    const agg = await getAggregateByStoryId(poll.story_id);
    view = toResultView(agg, DEFAULT_PUBLIC_FLOOR);
  } else {
    const agg = await computeArticlePollAggregate(poll);
    view = toResultView(agg, DEFAULT_PUBLIC_FLOOR);
  }

  const response: VoteResponseOk = {
    ok: true,
    inserted: result.inserted,
    result: view,
  };
  return NextResponse.json(response);
}
