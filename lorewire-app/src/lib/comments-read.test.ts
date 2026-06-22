// Coverage for the public thread read model. The load-bearing parts: a viewer
// sees their own held comment but nobody else's, replies group under the right
// parent, and keyset pagination returns each comment exactly once.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { all, run } from "@/lib/db";
import { createComment, setCommentStatus } from "./comments";
import { countPublishedComments, loadCommentThread } from "./comments-read";

async function clear(): Promise<void> {
  await run("DELETE FROM comment_moderation_events", []);
  await run("DELETE FROM comments", []);
  await run("DELETE FROM articles", []);
}

let articleId: string;

async function seedArticle(): Promise<string> {
  const id = randomUUID();
  await run(
    `INSERT INTO articles (id, language, slug, title, status, published_at, created_at)
     VALUES (?, 'en', ?, 'A', 'published', ?, ?)`,
    [id, `s-${id.slice(0, 8)}`, new Date().toISOString(), new Date().toISOString()],
  );
  return id;
}

/** Create a comment and publish it; returns its id. */
async function published(body: string, cookieToken = "c"): Promise<string> {
  const r = await createComment({
    articleId,
    guestName: "G",
    body,
    cookieToken,
    ipUaHash: "h",
  });
  if (!r.ok) throw new Error("create failed");
  await setCommentStatus(r.comment.id, "published", { source: "tier2" }, "ai");
  return r.comment.id;
}

beforeEach(async () => {
  await clear();
  articleId = await seedArticle();
});

describe("loadCommentThread — visibility", () => {
  it("shows a viewer's own held comment but hides it from others", async () => {
    const r = await createComment({
      articleId,
      guestName: "Me",
      body: "pending one",
      cookieToken: "mine",
      ipUaHash: "h",
    });
    if (!r.ok) throw new Error("create failed");
    // stays held

    const asOwner = await loadCommentThread({
      articleId,
      sort: "newest",
      viewerUserId: null,
      viewerCookieToken: "mine",
    });
    expect(asOwner.nodes.map((n) => n.id)).toContain(r.comment.id);
    expect(asOwner.nodes.find((n) => n.id === r.comment.id)?.isOwn).toBe(true);

    const asOther = await loadCommentThread({
      articleId,
      sort: "newest",
      viewerUserId: null,
      viewerCookieToken: "someone-else",
    });
    expect(asOther.nodes.map((n) => n.id)).not.toContain(r.comment.id);
  });

  it("hides a deleted comment even from its own author", async () => {
    const id = await published("to be deleted", "mine");
    await setCommentStatus(id, "deleted", { source: "human", reason: "by author" }, "author:guest");

    const page = await loadCommentThread({
      articleId,
      sort: "newest",
      viewerUserId: null,
      viewerCookieToken: "mine",
    });
    expect(page.nodes.map((n) => n.id)).not.toContain(id);
  });
});

describe("loadCommentThread — threading + sort", () => {
  it("groups published replies under their parent, newest top-level first", async () => {
    const a = await published("first top level");
    const b = await published("second top level");
    // a reply on `a`
    const reply = await createComment({
      articleId,
      parentId: a,
      guestName: "R",
      body: "a reply",
      cookieToken: "c",
      ipUaHash: "h",
    });
    if (!reply.ok) throw new Error("reply failed");
    await setCommentStatus(reply.comment.id, "published", { source: "tier2" }, "ai");

    const page = await loadCommentThread({
      articleId,
      sort: "newest",
      viewerUserId: null,
      viewerCookieToken: null,
    });
    // newest first => b before a
    expect(page.nodes[0].id).toBe(b);
    expect(page.nodes[1].id).toBe(a);
    expect(page.nodes[1].replies.map((r) => r.id)).toEqual([reply.comment.id]);
  });

  it("orders by likes for the top sort", async () => {
    const a = await published("low");
    const b = await published("high");
    await run("UPDATE comments SET like_count = ? WHERE id = ?", [9, b]);
    await run("UPDATE comments SET like_count = ? WHERE id = ?", [1, a]);

    const page = await loadCommentThread({
      articleId,
      sort: "top",
      viewerUserId: null,
      viewerCookieToken: null,
    });
    expect(page.nodes[0].id).toBe(b);
    expect(page.nodes[1].id).toBe(a);
  });

  it("paginates with a cursor, returning each comment once", async () => {
    const ids = [
      await published("one"),
      await published("two"),
      await published("three"),
    ];

    const p1 = await loadCommentThread({
      articleId,
      sort: "newest",
      limit: 2,
      viewerUserId: null,
      viewerCookieToken: null,
    });
    expect(p1.nodes).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();

    const p2 = await loadCommentThread({
      articleId,
      sort: "newest",
      limit: 2,
      cursor: p1.nextCursor,
      viewerUserId: null,
      viewerCookieToken: null,
    });
    expect(p2.nodes).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();

    const seen = [...p1.nodes, ...p2.nodes].map((n) => n.id).sort();
    expect(seen).toEqual([...ids].sort());
  });
});

describe("countPublishedComments", () => {
  it("counts published top-level and replies, not held", async () => {
    const a = await published("top");
    const reply = await createComment({
      articleId,
      parentId: a,
      guestName: "R",
      body: "reply",
      cookieToken: "c",
      ipUaHash: "h",
    });
    if (!reply.ok) throw new Error("reply failed");
    await setCommentStatus(reply.comment.id, "published", { source: "tier2" }, "ai");
    // a held one that should NOT count
    await createComment({ articleId, guestName: "H", body: "held", cookieToken: "c", ipUaHash: "h" });

    expect(await countPublishedComments(articleId)).toBe(2);
  });
});
