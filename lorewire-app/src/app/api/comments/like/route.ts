// Toggle a like on a published comment. Idempotent per viewer (signed-in by
// user id, guest by lw_comment cookie). Returns the authoritative {liked,
// likeCount} so the client can correct its optimistic state.
//
// Plan: _plans/2026-06-22-article-comments-ai-moderation.md (Step 6).

import { NextResponse, type NextRequest } from "next/server";
import { isAllowedOrigin } from "@/lib/request-origin";
import { readUserSession } from "@/lib/user-session";
import { getOrIssueCommentToken } from "@/lib/comment-cookie";
import { getCommentById, toggleLike } from "@/lib/comments";

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
  if (!comment || comment.status !== "published") {
    return NextResponse.json({ error: "comment not available" }, { status: 404 });
  }

  const session = await readUserSession();
  const cookieToken = await getOrIssueCommentToken();
  const result = await toggleLike({
    commentId,
    userId: session?.userId ?? null,
    cookieToken,
  });
  return NextResponse.json(result);
}
