// Public POST endpoint for submitting an article comment.
//
// Flow: same-origin gate -> shape validation -> identity (signed-in via
// lw_user, else guest with a name) -> DB-backed velocity limit -> issue the
// lw_comment token -> insert. Step 2 publishes immediately; Step 4 routes the
// new comment through the two-tier moderator before it becomes visible.
//
// Security (rule 13):
//   - Origin must match NEXT_PUBLIC_SITE_ORIGIN (shared isAllowedOrigin).
//   - Body is shape-validated; bad payloads 400 with no DB write.
//   - cookie_token and ip_ua_hash never appear in the response.
//   - Guests are name-only; we store no guest email by design.
//
// Plan: _plans/2026-06-22-article-comments-ai-moderation.md (Step 2).

import { NextResponse, type NextRequest } from "next/server";
import { isAllowedOrigin } from "@/lib/request-origin";
import { ipUaHash } from "@/lib/poll-rate-limit";
import { getOrIssueCommentToken } from "@/lib/comment-cookie";
import { readUserSession } from "@/lib/user-session";
import { readCommentToken } from "@/lib/comment-cookie";
import { getUserById } from "@/lib/users";
import { createComment, setCommentStatus, toPublicComment } from "@/lib/comments";
import { loadCommentThread, type CommentSort } from "@/lib/comments-read";
import { moderateComment } from "@/lib/comment-moderation";
import { checkCommentVelocity } from "@/lib/comment-rate-limit";

// Read a page of the thread (used by the client island for sort changes and
// "load more"). Read-only, so no origin gate; visibility of the viewer's own
// held comments is resolved from their session + lw_comment cookie.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const articleId = url.searchParams.get("articleId")?.trim() ?? "";
  if (!articleId) {
    return NextResponse.json({ error: "articleId required" }, { status: 400 });
  }
  const sort: CommentSort =
    url.searchParams.get("sort") === "top" ? "top" : "newest";
  const cursor = url.searchParams.get("cursor");
  const session = await readUserSession();
  const cookieToken = await readCommentToken();
  const page = await loadCommentThread({
    articleId,
    sort,
    cursor,
    viewerUserId: session?.userId ?? null,
    viewerCookieToken: cookieToken,
  });
  return NextResponse.json(page);
}

interface CommentBody {
  articleId?: unknown;
  parentId?: unknown;
  body?: unknown;
  guestName?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    console.warn("[comments post origin-rejected]", {
      received_origin: req.headers.get("origin"),
      expected_origin: process.env.NEXT_PUBLIC_SITE_ORIGIN ?? null,
      node_env: process.env.NODE_ENV,
    });
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  let body: CommentBody;
  try {
    body = (await req.json()) as CommentBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const articleId = typeof body.articleId === "string" ? body.articleId.trim() : "";
  if (!articleId) {
    return NextResponse.json({ error: "articleId required" }, { status: 400 });
  }
  const text = typeof body.body === "string" ? body.body : "";
  const parentId =
    typeof body.parentId === "string" && body.parentId.trim()
      ? body.parentId.trim()
      : null;
  const guestNameRaw = typeof body.guestName === "string" ? body.guestName : "";

  const session = await readUserSession();
  const isGuest = !session;

  // Bucket by (ip, ua). Vercel surfaces the client IP via x-forwarded-for;
  // local dev collapses to one bucket, which is fine.
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const ua = req.headers.get("user-agent") ?? "";
  const hash = ipUaHash(ip || null, ua || null);

  // Resolve / issue the per-browser token before the velocity check so the
  // guest cookie bucket is populated on the very first submit.
  const cookieToken = await getOrIssueCommentToken();

  const velocity = await checkCommentVelocity({
    ipUaHash: hash,
    cookieToken,
    isGuest,
  });
  if (!velocity.ok) {
    console.warn("[comments rate-limit]", {
      hash_prefix: hash.slice(0, 8),
      window: velocity.window,
      is_guest: isGuest,
    });
    return NextResponse.json(
      { error: "You're commenting too fast. Try again in a moment." },
      { status: 429, headers: { "Retry-After": String(velocity.retryAfterSec) } },
    );
  }

  const result = await createComment({
    articleId,
    parentId,
    authorUserId: session?.userId ?? null,
    guestName: isGuest ? guestNameRaw : null,
    body: text,
    cookieToken,
    ipUaHash: hash,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.httpStatus });
  }

  // Moderate inline. moderateComment never throws; on timeout it returns a
  // held verdict and the cron drain retries it. setCommentStatus resolves the
  // status, maintains the parent reply_count, and writes the audit row.
  const verdict = await moderateComment({
    body: result.comment.body,
    lang: result.comment.lang ?? "en",
    articleTitle: result.articleTitle,
    articleSummary: result.articleSummary,
  });
  const finalRow =
    (await setCommentStatus(
      result.comment.id,
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
    )) ?? result.comment;

  // Resolve the display name for the immediate optimistic render: guests use
  // their typed name; signed-in authors use their profile name (falling back
  // to the local-part of their email).
  let authorName = result.comment.guest_name ?? "Reader";
  if (session?.userId) {
    const user = await getUserById(session.userId);
    authorName = user?.name?.trim() || session.email.split("@")[0] || "Reader";
  }

  return NextResponse.json({
    ok: true,
    comment: toPublicComment(finalRow, authorName, {
      viewerUserId: session?.userId ?? null,
      viewerCookieToken: cookieToken,
    }),
  });
}
