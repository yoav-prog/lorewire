// Public appeal endpoint. A comment's own author can ask for a human to
// reconsider an AI rejection: the comment moves back to 'held' (source
// 'appeal') and reappears in /admin/comments. This is the DSA-style redress
// path — every rejection the reader sees comes with a one-click appeal.
//
// Authorization is ownership, not a role: the requester must be the comment's
// author, matched by signed-in user id OR by the lw_comment cookie token. Only
// a 'rejected' comment can be appealed (you don't appeal a published one), and
// the cron never re-touches an 'appeal' (its source isn't pending/timeout), so
// it waits for a human.
//
// Plan: _plans/2026-06-22-article-comments-ai-moderation.md (Step 5).

import { NextResponse, type NextRequest } from "next/server";
import { isAllowedOrigin } from "@/lib/request-origin";
import { readUserSession } from "@/lib/user-session";
import { readCommentToken } from "@/lib/comment-cookie";
import { getCommentById, setCommentStatus } from "@/lib/comments";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  let body: { commentId?: unknown };
  try {
    body = (await req.json()) as { commentId?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const commentId = typeof body.commentId === "string" ? body.commentId.trim() : "";
  if (!commentId) {
    return NextResponse.json({ error: "commentId required" }, { status: 400 });
  }

  const comment = await getCommentById(commentId);
  if (!comment) {
    return NextResponse.json({ error: "comment not found" }, { status: 404 });
  }

  // Ownership check: signed-in author, or the same browser that posted it.
  const session = await readUserSession();
  const cookieToken = await readCommentToken();
  const ownsByUser =
    !!session && !!comment.author_user_id && comment.author_user_id === session.userId;
  const ownsByCookie =
    !!cookieToken && !!comment.cookie_token && comment.cookie_token === cookieToken;
  if (!ownsByUser && !ownsByCookie) {
    // Don't leak whether the comment exists to a non-owner.
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (comment.status !== "rejected") {
    return NextResponse.json(
      { error: "Only a rejected comment can be appealed." },
      { status: 409 },
    );
  }

  await setCommentStatus(
    commentId,
    "held",
    { source: "appeal", reason: "The author appealed this decision." },
    ownsByUser ? `author:${session!.userId}` : "author:guest",
  );

  return NextResponse.json({ ok: true });
}
