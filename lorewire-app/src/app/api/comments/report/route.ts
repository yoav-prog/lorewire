// Reader report on a published comment. Filing a report does not hide the
// comment (that would let one person mute anyone); it surfaces the comment in
// the admin queue for a human. One open report per viewer per comment.
//
// Plan: _plans/2026-06-22-article-comments-ai-moderation.md (Step 5 reports).

import { NextResponse, type NextRequest } from "next/server";
import { isAllowedOrigin } from "@/lib/request-origin";
import { readUserSession } from "@/lib/user-session";
import { getOrIssueCommentToken } from "@/lib/comment-cookie";
import { getCommentById, reportComment } from "@/lib/comments";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }
  let body: { commentId?: unknown; reason?: unknown };
  try {
    body = (await req.json()) as { commentId?: unknown; reason?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const commentId = typeof body.commentId === "string" ? body.commentId.trim() : "";
  if (!commentId) {
    return NextResponse.json({ error: "commentId required" }, { status: 400 });
  }
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : null;

  const comment = await getCommentById(commentId);
  if (!comment || comment.status !== "published") {
    return NextResponse.json({ error: "comment not available" }, { status: 404 });
  }

  const session = await readUserSession();
  const cookieToken = await getOrIssueCommentToken();
  const result = await reportComment({
    commentId,
    reporterUserId: session?.userId ?? null,
    cookieToken,
    reason,
  });
  return NextResponse.json(result);
}
