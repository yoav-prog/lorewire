// Edit (PATCH) or delete (DELETE) the viewer's OWN comment. Authorization is
// ownership, matched by signed-in user id or the lw_comment cookie token.
//
// Edit re-runs the full moderator on the new body (council finding: an edit can
// turn a clean comment into a violation, so it must not bypass moderation) — so
// an edited comment can flip from published to held/rejected. Delete is a soft
// delete to 'deleted', routed through setCommentStatus so the reply_count and
// audit trail stay correct; the read model hides 'deleted' from everyone.
//
// Plan: _plans/2026-06-22-article-comments-ai-moderation.md (Step 6).

import { NextResponse, type NextRequest } from "next/server";
import { isAllowedOrigin } from "@/lib/request-origin";
import { readUserSession } from "@/lib/user-session";
import { readCommentToken } from "@/lib/comment-cookie";
import { getUserById } from "@/lib/users";
import { getArticle } from "@/lib/repo";
import {
  COMMENT_BODY_MAX,
  getCommentById,
  setCommentBody,
  setCommentStatus,
  toPublicComment,
  type CommentRow,
} from "@/lib/comments";
import { moderateComment } from "@/lib/comment-moderation";

interface Owner {
  ok: boolean;
  userId: string | null;
  cookieToken: string | null;
}

async function resolveOwner(comment: CommentRow): Promise<Owner> {
  const session = await readUserSession();
  const cookieToken = await readCommentToken();
  const ownsByUser =
    !!session && !!comment.author_user_id && comment.author_user_id === session.userId;
  const ownsByCookie =
    !!cookieToken && !!comment.cookie_token && comment.cookie_token === cookieToken;
  return {
    ok: ownsByUser || ownsByCookie,
    userId: session?.userId ?? null,
    cookieToken,
  };
}

async function resolveAuthorName(
  row: CommentRow,
  userId: string | null,
): Promise<string> {
  if (userId) {
    const user = await getUserById(userId);
    if (user?.name?.trim()) return user.name.trim();
  }
  return row.guest_name ?? "Reader";
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }
  const { id } = await params;
  let body: { body?: unknown };
  try {
    body = (await req.json()) as { body?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "Comment can't be empty." }, { status: 400 });
  }
  if (text.length > COMMENT_BODY_MAX) {
    return NextResponse.json({ error: "Comment is too long." }, { status: 400 });
  }

  const comment = await getCommentById(id);
  if (!comment) return NextResponse.json({ error: "not found" }, { status: 404 });
  const owner = await resolveOwner(comment);
  if (!owner.ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (comment.status === "deleted") {
    return NextResponse.json({ error: "comment unavailable" }, { status: 409 });
  }

  await setCommentBody(id, text);
  const article = await getArticle(comment.article_id);
  const verdict = await moderateComment({
    body: text,
    lang: comment.lang ?? "en",
    articleTitle: article?.title ?? "",
    articleSummary: article?.summary ?? "",
  });
  const finalRow =
    (await setCommentStatus(
      id,
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
    )) ?? comment;

  const authorName = await resolveAuthorName(finalRow, owner.userId);
  return NextResponse.json({
    ok: true,
    comment: toPublicComment(finalRow, authorName, {
      viewerUserId: owner.userId,
      viewerCookieToken: owner.cookieToken,
    }),
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }
  const { id } = await params;
  const comment = await getCommentById(id);
  if (!comment) return NextResponse.json({ error: "not found" }, { status: 404 });
  const owner = await resolveOwner(comment);
  if (!owner.ok) return NextResponse.json({ error: "not found" }, { status: 404 });

  await setCommentStatus(
    id,
    "deleted",
    { source: "human", reason: "Deleted by the author." },
    owner.userId ? `author:${owner.userId}` : "author:guest",
  );
  return NextResponse.json({ ok: true });
}
