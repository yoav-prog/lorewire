// Coverage for the comments data layer (Step 2). The validation rules and the
// one-level reply invariant are the load-bearing parts: a wrong check here
// either drops a valid comment or lets a malformed thread (a reply to a reply,
// or a reply across articles) into the store. Runs against the shared
// per-process test SQLite from tests/setup.ts; ensureSchema creates the
// comments + articles tables on first query.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { all, run } from "@/lib/db";
import { setSetting } from "@/lib/repo";
import {
  commentsEnabledForArticle,
  createComment,
  getCommentById,
  listModerationQueue,
  reportComment,
  resolveReports,
  setCommentStatus,
  toggleLike,
  toPublicComment,
  type CommentRow,
} from "./comments";

async function clear(): Promise<void> {
  await run("DELETE FROM comment_reports", []);
  await run("DELETE FROM comment_moderation_events", []);
  await run("DELETE FROM comments", []);
  await run("DELETE FROM articles", []);
  await run("DELETE FROM stories", []);
}

async function seedArticle(
  status: string,
  language = "en",
): Promise<string> {
  const id = randomUUID();
  await run(
    `INSERT INTO articles (id, language, slug, title, status, published_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      language,
      `slug-${id.slice(0, 8)}`,
      "Test article",
      status,
      status === "published" ? new Date().toISOString() : null,
      new Date().toISOString(),
    ],
  );
  return id;
}

// Seed a story so createComment can fall back to it when no article matches.
// Mirrors the homepage modal flow for ideas-imported stories (slug == id,
// no linked article).
async function seedStory(status: string): Promise<string> {
  const id = `idea_${randomUUID().slice(0, 12)}`;
  await run(
    `INSERT INTO stories (id, slug, title, summary, status, published_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      id,
      "Test story",
      "Test summary",
      status,
      status === "published" ? new Date().toISOString() : null,
      new Date().toISOString(),
    ],
  );
  return id;
}

const base = { cookieToken: "cookie-a", ipUaHash: "hash-a" };

describe("createComment — validation", () => {
  beforeEach(clear);

  it("rejects an empty body", async () => {
    const articleId = await seedArticle("published");
    const r = await createComment({ articleId, guestName: "Sam", body: "   ", ...base });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.httpStatus).toBe(400);
  });

  it("rejects a body over the length cap", async () => {
    const articleId = await seedArticle("published");
    const r = await createComment({
      articleId,
      guestName: "Sam",
      body: "x".repeat(4001),
      ...base,
    });
    expect(r.ok).toBe(false);
  });

  it("requires a name from guests", async () => {
    const articleId = await seedArticle("published");
    const r = await createComment({ articleId, body: "hello", ...base });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.httpStatus).toBe(400);
  });

  it("does not require a name from signed-in users", async () => {
    const articleId = await seedArticle("published");
    const r = await createComment({
      articleId,
      authorUserId: "user-1",
      body: "hello",
      ...base,
    });
    expect(r.ok).toBe(true);
  });

  it("refuses comments on a non-published article", async () => {
    const articleId = await seedArticle("draft");
    const r = await createComment({ articleId, guestName: "Sam", body: "hi", ...base });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.httpStatus).toBe(404);
  });

  it("accepts a comment on a published article whose published_at is null", async () => {
    // Regression: older rows can be status='published' with a null
    // published_at (the publish path didn't always backfill it). The reader
    // serves these articles, so the comment gate must too — otherwise the UI
    // shows the composer and every Post returns "This article isn't open for
    // comments."
    const id = randomUUID();
    await run(
      `INSERT INTO articles (id, language, slug, title, status, published_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        "en",
        `slug-${id.slice(0, 8)}`,
        "Legacy published article",
        "published",
        null,
        new Date().toISOString(),
      ],
    );
    const r = await createComment({ articleId: id, guestName: "Sam", body: "hi", ...base });
    expect(r.ok).toBe(true);
  });

  it("refuses a comment on a missing article", async () => {
    const r = await createComment({
      articleId: "does-not-exist",
      guestName: "Sam",
      body: "hi",
      ...base,
    });
    expect(r.ok).toBe(false);
  });

  it("accepts a comment keyed on a published story when no article links to it", async () => {
    // Regression: the homepage modal mounts a CommentsTab keyed on storyId;
    // /api/comments/count returns the storyId verbatim as the comments key
    // when no published article links. createComment must accept that key —
    // otherwise the UI shows a working composer that always 404s. Affects
    // every ideas-imported story (idea_* prefix) until it gets a linked
    // article.
    const storyId = await seedStory("published");
    const r = await createComment({ articleId: storyId, guestName: "Sam", body: "hi", ...base });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.comment.article_id).toBe(storyId);
      expect(r.articleTitle).toBe("Test story");
      expect(r.articleSummary).toBe("Test summary");
    }
  });

  it("refuses a comment on an unpublished story (no article fallback)", async () => {
    const storyId = await seedStory("draft");
    const r = await createComment({ articleId: storyId, guestName: "Sam", body: "hi", ...base });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.httpStatus).toBe(404);
  });
});

describe("createComment — threading", () => {
  beforeEach(clear);

  it("inserts a top-level comment as held (pending moderation) and detects Hebrew", async () => {
    const articleId = await seedArticle("published");
    const r = await createComment({
      articleId,
      guestName: "דנה",
      body: "תגובה בעברית",
      ...base,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.comment.status).toBe("held");
      expect(r.comment.moderation_source).toBe("pending");
      expect(r.comment.lang).toBe("he");
      expect(r.comment.parent_id).toBeNull();
      expect(r.articleTitle).toBe("Test article");
    }
  });

  it("bumps the parent reply_count only when a reply is published", async () => {
    const articleId = await seedArticle("published");
    const parent = await createComment({ articleId, guestName: "A", body: "parent", ...base });
    if (!parent.ok) throw new Error("parent failed");
    // A reply is only allowed once the parent is published — the route
    // moderates the parent before anyone can see and reply to it.
    await setCommentStatus(parent.comment.id, "published", { source: "tier2" }, "ai");
    const reply = await createComment({
      articleId,
      parentId: parent.comment.id,
      guestName: "B",
      body: "reply",
      ...base,
    });
    if (!reply.ok) throw new Error("reply failed");
    expect(reply.comment.parent_id).toBe(parent.comment.id);

    // A held reply does not count yet.
    expect((await getCommentById(parent.comment.id))?.reply_count).toBe(0);

    // Publishing the reply bumps the parent; rejecting it back decrements.
    await setCommentStatus(reply.comment.id, "published", { source: "tier2" }, "ai");
    expect((await getCommentById(parent.comment.id))?.reply_count).toBe(1);
    await setCommentStatus(reply.comment.id, "rejected", { source: "human" }, "admin-1");
    expect((await getCommentById(parent.comment.id))?.reply_count).toBe(0);
  });

  it("refuses a reply to a reply (one level deep)", async () => {
    const articleId = await seedArticle("published");
    const parent = await createComment({ articleId, guestName: "A", body: "parent", ...base });
    if (!parent.ok) throw new Error("parent failed");
    await setCommentStatus(parent.comment.id, "published", { source: "tier2" }, "ai");
    const reply = await createComment({
      articleId,
      parentId: parent.comment.id,
      guestName: "B",
      body: "reply",
      ...base,
    });
    if (!reply.ok) throw new Error("reply failed");
    await setCommentStatus(reply.comment.id, "published", { source: "tier2" }, "ai");

    const nested = await createComment({
      articleId,
      parentId: reply.comment.id,
      guestName: "C",
      body: "nested",
      ...base,
    });
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.httpStatus).toBe(400);
  });

  it("refuses a reply whose parent is on a different article", async () => {
    const articleA = await seedArticle("published");
    const articleB = await seedArticle("published");
    const parent = await createComment({ articleId: articleA, guestName: "A", body: "p", ...base });
    if (!parent.ok) throw new Error("parent failed");
    const cross = await createComment({
      articleId: articleB,
      parentId: parent.comment.id,
      guestName: "B",
      body: "cross",
      ...base,
    });
    expect(cross.ok).toBe(false);
  });
});

describe("setCommentStatus — audit + signal preservation", () => {
  beforeEach(clear);

  it("writes an immutable audit row on each transition", async () => {
    const articleId = await seedArticle("published");
    const c = await createComment({ articleId, guestName: "A", body: "hi", ...base });
    if (!c.ok) throw new Error("create failed");

    await setCommentStatus(
      c.comment.id,
      "published",
      { source: "tier2", category: "clean", reason: "looks fine", stance: "agree" },
      "ai",
    );
    await setCommentStatus(c.comment.id, "rejected", { source: "human", reason: "changed my mind" }, "admin-1");

    const events = await all<{ from_status: string; to_status: string; actor: string }>(
      "SELECT from_status, to_status, actor FROM comment_moderation_events WHERE comment_id = ? ORDER BY created_at",
      [c.comment.id],
    );
    expect(events.length).toBe(2);
    expect(events[0].from_status).toBe("held");
    expect(events[0].to_status).toBe("published");
    expect(events[1].to_status).toBe("rejected");
    expect(events[1].actor).toBe("admin-1");
  });

  it("preserves the judge's editorial signal across a human action", async () => {
    const articleId = await seedArticle("published");
    const c = await createComment({ articleId, guestName: "A", body: "hi", ...base });
    if (!c.ok) throw new Error("create failed");

    // Judge writes the signal...
    await setCommentStatus(
      c.comment.id,
      "published",
      { source: "tier2", stance: "disagree", sentiment: "negative", topicTag: "seat dispute" },
      "ai",
    );
    // ...a later human reject passes no signal fields; they must survive.
    await setCommentStatus(c.comment.id, "rejected", { source: "human", reason: "spam" }, "admin-1");

    const row = await getCommentById(c.comment.id);
    expect(row?.stance).toBe("disagree");
    expect(row?.sentiment).toBe("negative");
    expect(row?.topic_tag).toBe("seat dispute");
    expect(row?.moderation_reason).toBe("spam");
  });
});

describe("listModerationQueue", () => {
  beforeEach(clear);

  it("surfaces held + quarantined with author/article joined, excludes published", async () => {
    const articleId = await seedArticle("published");
    const held = await createComment({ articleId, guestName: "Held Guy", body: "borderline", ...base });
    const quar = await createComment({ articleId, guestName: "Quar Guy", body: "severe", ...base });
    const pub = await createComment({ articleId, guestName: "Pub Guy", body: "fine", ...base });
    if (!held.ok || !quar.ok || !pub.ok) throw new Error("seed failed");

    await setCommentStatus(
      quar.comment.id,
      "quarantined",
      { source: "tier1", category: "sexual/minors", reason: "severe" },
      "ai",
    );
    await setCommentStatus(pub.comment.id, "published", { source: "tier2" }, "ai");

    const queue = await listModerationQueue(100);
    const ids = queue.map((r) => r.id);
    expect(ids).toContain(held.comment.id);
    expect(ids).toContain(quar.comment.id);
    expect(ids).not.toContain(pub.comment.id);

    const heldRow = queue.find((r) => r.id === held.comment.id)!;
    expect(heldRow.article_title).toBe("Test article");
    expect(heldRow.author_name).toBe("Held Guy");
    expect(Number(heldRow.is_guest)).toBe(1);
    expect(Number(heldRow.open_reports)).toBe(0);

    const quarRow = queue.find((r) => r.id === quar.comment.id)!;
    expect(quarRow.status).toBe("quarantined");
    expect(quarRow.moderation_category).toBe("sexual/minors");
  });
});

describe("toggleLike", () => {
  beforeEach(clear);

  it("toggles a like and keeps the count, counting distinct viewers", async () => {
    const articleId = await seedArticle("published");
    const c = await createComment({ articleId, guestName: "A", body: "hi", ...base });
    if (!c.ok) throw new Error("create failed");
    await setCommentStatus(c.comment.id, "published", { source: "tier2" }, "ai");

    expect(await toggleLike({ commentId: c.comment.id, userId: null, cookieToken: "cook1" }))
      .toEqual({ liked: true, likeCount: 1 });
    expect(await toggleLike({ commentId: c.comment.id, userId: null, cookieToken: "cook1" }))
      .toEqual({ liked: false, likeCount: 0 });

    await toggleLike({ commentId: c.comment.id, userId: null, cookieToken: "cook1" });
    const r = await toggleLike({ commentId: c.comment.id, userId: "user-9", cookieToken: "cook2" });
    expect(r.likeCount).toBe(2);
  });
});

describe("commentsEnabledForArticle", () => {
  it("respects the site-wide and per-article switches", async () => {
    const articleId = await seedArticle("published");
    await setSetting("comments.enabled", "1");
    expect(await commentsEnabledForArticle(articleId)).toBe(true);

    await setSetting(`comments.article_off.${articleId}`, "1");
    expect(await commentsEnabledForArticle(articleId)).toBe(false);
    await setSetting(`comments.article_off.${articleId}`, "0");
    expect(await commentsEnabledForArticle(articleId)).toBe(true);

    await setSetting("comments.enabled", "0");
    expect(await commentsEnabledForArticle(articleId)).toBe(false);
    await setSetting("comments.enabled", "1"); // reset for other suites
  });
});

describe("reports", () => {
  beforeEach(clear);

  it("files one open report per viewer, surfaces it in the queue, and clears on resolve", async () => {
    const articleId = await seedArticle("published");
    const c = await createComment({ articleId, guestName: "A", body: "hi", ...base });
    if (!c.ok) throw new Error("create failed");
    await setCommentStatus(c.comment.id, "published", { source: "tier2" }, "ai");

    expect(
      await reportComment({ commentId: c.comment.id, reporterUserId: null, cookieToken: "rep1", reason: "spam" }),
    ).toEqual({ ok: true, already: false });
    // same viewer can't pile on
    expect(
      (await reportComment({ commentId: c.comment.id, reporterUserId: null, cookieToken: "rep1", reason: null })).already,
    ).toBe(true);

    const queue = await listModerationQueue(100);
    const row = queue.find((q) => q.id === c.comment.id);
    expect(row).toBeTruthy();
    expect(Number(row!.open_reports)).toBe(1);

    await resolveReports(c.comment.id, "dismissed");
    expect((await listModerationQueue(100)).find((q) => q.id === c.comment.id)).toBeFalsy();
  });
});

describe("toPublicComment", () => {
  const row: CommentRow = {
    id: "c1",
    article_id: "a1",
    parent_id: null,
    author_user_id: null,
    guest_name: "Sam",
    body: "hello",
    lang: "en",
    status: "held",
    moderation_source: "tier2",
    moderation_category: "borderline",
    moderation_reason: "needs a human look",
    moderation_confidence: 0.5,
    stance: null,
    sentiment: null,
    topic_tag: null,
    like_count: 3,
    reply_count: 0,
    cookie_token: "cookie-a",
    ip_ua_hash: "hash-a",
    edited_at: null,
    created_at: "2026-06-22T00:00:00.000Z",
  };

  it("never leaks cookie_token or ip_ua_hash", async () => {
    const pub = toPublicComment(row, "Sam", { viewerUserId: null, viewerCookieToken: null });
    expect(JSON.stringify(pub)).not.toContain("cookie-a");
    expect(JSON.stringify(pub)).not.toContain("hash-a");
  });

  it("shows the moderation reason only to the comment's own author", async () => {
    const other = toPublicComment(row, "Sam", { viewerUserId: null, viewerCookieToken: "someone-else" });
    expect(other.isOwn).toBe(false);
    expect(other.moderationReason).toBeNull();

    const own = toPublicComment(row, "Sam", { viewerUserId: null, viewerCookieToken: "cookie-a" });
    expect(own.isOwn).toBe(true);
    expect(own.moderationReason).toBe("needs a human look");
  });
});
