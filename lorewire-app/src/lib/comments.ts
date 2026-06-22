// Comments data layer. CRUD + read helpers over the `comments` table
// (_plans/2026-06-22-article-comments-ai-moderation.md). Moderation decisions
// live in src/lib/comment-moderation.ts; this module only persists and reads.
//
// New comments are inserted as 'held' (pending). The write path then runs the
// two-tier moderator and calls setCommentStatus, which is the single chokepoint
// every status change (AI, admin, re-moderation) flows through — it maintains
// the parent reply_count (published replies only) and writes the audit trail.

import "server-only";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";
import { getArticle } from "@/lib/repo";

export type CommentStatus =
  | "published"
  | "held"
  | "rejected"
  | "quarantined"
  | "deleted";

export interface CommentRow {
  id: string;
  article_id: string;
  parent_id: string | null;
  author_user_id: string | null;
  guest_name: string | null;
  body: string;
  lang: string | null;
  status: string;
  moderation_source: string | null;
  moderation_category: string | null;
  moderation_reason: string | null;
  moderation_confidence: number | null;
  stance: string | null;
  sentiment: string | null;
  topic_tag: string | null;
  like_count: number | null;
  reply_count: number | null;
  cookie_token: string | null;
  ip_ua_hash: string | null;
  edited_at: string | null;
  created_at: string | null;
}

const COMMENT_COLS =
  "id, article_id, parent_id, author_user_id, guest_name, body, lang, status, " +
  "moderation_source, moderation_category, moderation_reason, moderation_confidence, " +
  "stance, sentiment, topic_tag, like_count, reply_count, cookie_token, ip_ua_hash, " +
  "edited_at, created_at";

export const COMMENT_BODY_MAX = 4000;
export const GUEST_NAME_MAX = 60;

export interface CreateCommentInput {
  articleId: string;
  parentId?: string | null;
  /** Set for signed-in users; null for guests. */
  authorUserId?: string | null;
  /** Set for guests; ignored for signed-in users. */
  guestName?: string | null;
  body: string;
  cookieToken: string;
  ipUaHash: string;
}

export type CreateCommentResult =
  | {
      ok: true;
      comment: CommentRow;
      /** Article context for the moderator, returned so the write path does
       *  not re-fetch the article it just validated. */
      articleTitle: string;
      articleSummary: string;
    }
  | { ok: false; error: string; httpStatus: number };

/** Hebrew if the body contains any Hebrew-block codepoint, else the article's
 *  language. Good enough to route the moderator and pick text direction; the
 *  judge itself is language-agnostic. */
function detectLang(text: string, fallback: string): string {
  return /[֐-׿]/.test(text) ? "he" : fallback || "en";
}

export async function getCommentById(id: string): Promise<CommentRow | null> {
  if (!id) return null;
  return one<CommentRow>(
    `SELECT ${COMMENT_COLS} FROM comments WHERE id = ?`,
    [id],
  );
}

export async function createComment(
  input: CreateCommentInput,
): Promise<CreateCommentResult> {
  const body = (input.body ?? "").trim();
  if (!body) return { ok: false, error: "Comment can't be empty.", httpStatus: 400 };
  if (body.length > COMMENT_BODY_MAX) {
    return { ok: false, error: "Comment is too long.", httpStatus: 400 };
  }

  const isGuest = !input.authorUserId;
  const guestName = isGuest ? (input.guestName ?? "").trim() : null;
  if (isGuest) {
    if (!guestName) return { ok: false, error: "Add a name to comment.", httpStatus: 400 };
    if (guestName.length > GUEST_NAME_MAX) {
      return { ok: false, error: "That name is too long.", httpStatus: 400 };
    }
  }

  const article = await getArticle(input.articleId);
  if (!article || article.status !== "published" || !article.published_at) {
    return { ok: false, error: "This article isn't open for comments.", httpStatus: 404 };
  }

  // One level of replies only: a reply must target a published top-level
  // comment on the same article.
  let parentId: string | null = null;
  if (input.parentId) {
    const parent = await getCommentById(input.parentId);
    if (!parent || parent.article_id !== article.id || parent.status !== "published") {
      return { ok: false, error: "That comment is no longer available.", httpStatus: 404 };
    }
    if (parent.parent_id) {
      return { ok: false, error: "Replies only go one level deep.", httpStatus: 400 };
    }
    parentId = parent.id;
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const lang = detectLang(body, article.language ?? "en");

  // Insert as 'held'/'pending'. The write path moderates immediately and calls
  // setCommentStatus to resolve the status; the parent reply_count is bumped
  // there, only if/when the reply actually becomes published.
  await run(
    `INSERT INTO comments
       (id, article_id, parent_id, author_user_id, guest_name, body, lang,
        status, moderation_source, like_count, reply_count, cookie_token,
        ip_ua_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      article.id,
      parentId,
      input.authorUserId ?? null,
      guestName,
      body,
      lang,
      "held",
      "pending",
      0,
      0,
      input.cookieToken,
      input.ipUaHash,
      now,
    ],
  );

  const created = await getCommentById(id);
  if (!created) return { ok: false, error: "Could not save the comment.", httpStatus: 500 };
  return {
    ok: true,
    comment: created,
    articleTitle: article.title ?? "",
    articleSummary: article.summary ?? "",
  };
}

export interface ModerationFields {
  source?: string | null;
  category?: string | null;
  reason?: string | null;
  confidence?: number | null;
  stance?: string | null;
  sentiment?: string | null;
  topicTag?: string | null;
}

/** Transition a comment to a new status. The single chokepoint for every
 *  status change (AI verdict, admin action, re-moderation on edit) so two
 *  invariants can never drift: the parent reply_count counts published direct
 *  replies only, and every transition leaves an immutable audit row. `actor` is
 *  "ai" or an admin user id. Provided moderation fields overwrite; omitted ones
 *  keep their prior value (so a human action doesn't wipe the judge's editorial
 *  signal). */
export async function setCommentStatus(
  id: string,
  toStatus: CommentStatus,
  fields: ModerationFields,
  actor: string,
): Promise<CommentRow | null> {
  const current = await getCommentById(id);
  if (!current) return null;
  const from = current.status;
  const now = new Date().toISOString();

  // Merge in JS (not SQL COALESCE) so we bind concrete column values — avoids
  // Postgres "could not determine data type" on an untyped null inside COALESCE.
  const next = {
    source: fields.source ?? current.moderation_source,
    category: fields.category ?? current.moderation_category,
    reason: fields.reason ?? current.moderation_reason,
    confidence: fields.confidence ?? current.moderation_confidence,
    stance: fields.stance ?? current.stance,
    sentiment: fields.sentiment ?? current.sentiment,
    topicTag: fields.topicTag ?? current.topic_tag,
  };

  await run(
    `UPDATE comments SET
        status = ?, moderation_source = ?, moderation_category = ?,
        moderation_reason = ?, moderation_confidence = ?, stance = ?,
        sentiment = ?, topic_tag = ?
      WHERE id = ?`,
    [
      toStatus,
      next.source,
      next.category,
      next.reason,
      next.confidence,
      next.stance,
      next.sentiment,
      next.topicTag,
      id,
    ],
  );

  if (current.parent_id) {
    if (from !== "published" && toStatus === "published") {
      await run(
        `UPDATE comments SET reply_count = reply_count + 1 WHERE id = ?`,
        [current.parent_id],
      );
    } else if (from === "published" && toStatus !== "published") {
      await run(
        `UPDATE comments SET reply_count = reply_count - 1 WHERE id = ?`,
        [current.parent_id],
      );
    }
  }

  await run(
    `INSERT INTO comment_moderation_events
       (id, comment_id, actor, from_status, to_status, category, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), id, actor, from, toStatus, next.category, next.reason, now],
  );

  return getCommentById(id);
}

/** Comments stuck pending or timed-out in moderation, for the cron retry net.
 *  Excludes comments deliberately 'held' for a human (their source is a judge
 *  verdict, not 'pending'/'timeout'). */
export async function listStaleModerationComments(
  limit: number,
): Promise<CommentRow[]> {
  return all<CommentRow>(
    `SELECT ${COMMENT_COLS} FROM comments
      WHERE status = 'held' AND moderation_source IN ('pending', 'timeout')
      ORDER BY created_at ASC
      LIMIT ?`,
    [limit],
  );
}

/** Created-at timestamps (ISO, newest first) for one rate-limit bucket since a
 *  cutoff. The caller derives per-window counts; one query covers minute/hour/
 *  day so the velocity check is a single round trip. */
export async function recentCommentTimes(
  field: "ip_ua_hash" | "cookie_token",
  value: string,
  sinceIso: string,
): Promise<string[]> {
  if (!value) return [];
  const rows = await all<{ created_at: string }>(
    `SELECT created_at FROM comments
      WHERE ${field} = ? AND created_at >= ?
      ORDER BY created_at DESC`,
    [value, sinceIso],
  );
  return rows.map((r) => r.created_at);
}

// ---- Public view -------------------------------------------------------

export interface PublicComment {
  id: string;
  articleId: string;
  parentId: string | null;
  authorName: string;
  /** True for the viewer's own comment (matched by user id or cookie token),
   *  so the UI can show its held/rejected status and an edit/delete affordance. */
  isOwn: boolean;
  status: CommentStatus;
  body: string;
  likeCount: number;
  replyCount: number;
  /** Statement of reasons, surfaced only to the comment's own author. */
  moderationReason: string | null;
  createdAt: string | null;
  editedAt: string | null;
}

export interface ViewerContext {
  viewerUserId: string | null;
  viewerCookieToken: string | null;
}

/** Map a stored row to the public shape. Never leaks cookie_token, ip_ua_hash,
 *  or another author's moderation reason. `authorName` is resolved by the
 *  caller (guest_name for guests, users.name for signed-in authors). */
export function toPublicComment(
  row: CommentRow,
  authorName: string,
  viewer: ViewerContext,
): PublicComment {
  const isOwn =
    (!!viewer.viewerUserId && row.author_user_id === viewer.viewerUserId) ||
    (!!viewer.viewerCookieToken && row.cookie_token === viewer.viewerCookieToken);
  return {
    id: row.id,
    articleId: row.article_id,
    parentId: row.parent_id,
    authorName,
    isOwn,
    status: row.status as CommentStatus,
    body: row.body ?? "",
    likeCount: row.like_count ?? 0,
    replyCount: row.reply_count ?? 0,
    moderationReason: isOwn ? row.moderation_reason : null,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };
}
