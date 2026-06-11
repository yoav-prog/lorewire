// Phase 1 repo tests for the articles CMS. Covers:
//   - CRUD: create, get-by-id, get-by-slug, list (slim + filters), delete
//   - EDITABLE allow-list enforcement (non-editable fields silently dropped)
//   - Slug collision scoped per-language (he/foo and en/foo coexist)
//   - Status transitions and the published_at side-effect
//   - Revision coalescing window (update-in-place vs new row)
//
// These run against SQLite via tests/setup.ts. Postgres-engine parity tests
// land in a later phase when CI is wired.

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createArticle,
  getArticle,
  getArticleBySlug,
  listArticlesSlim,
  updateArticle,
  updateArticleSlug,
  setArticleStatus,
  deleteArticle,
  appendRevision,
  listRevisions,
  checkSlugAvailable,
} from "@/lib/repo";

// Touching ARTICLES once in a `beforeAll` triggers the lazy schema creation in
// db.ts so the first test's create insert lands in a real table. Without this
// any test that calls createArticle directly would race the lazy schema build.
beforeAll(async () => {
  await listArticlesSlim({ limit: 1 });
});

function mkInput(overrides: Partial<Parameters<typeof createArticle>[0]> = {}) {
  const id = randomUUID();
  return {
    id,
    type: "feature" as const,
    language: "en" as const,
    slug: `test-${id.slice(0, 6)}`,
    title: "Test article",
    author_id: null,
    ...overrides,
  };
}

describe("articles repo / CRUD", () => {
  it("creates a draft article with an empty Tiptap document", async () => {
    const input = mkInput();
    await createArticle(input);
    const row = await getArticle(input.id);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(input.id);
    expect(row?.type).toBe("feature");
    expect(row?.language).toBe("en");
    expect(row?.slug).toBe(input.slug);
    expect(row?.title).toBe("Test article");
    expect(row?.status).toBe("draft");
    // Document is an empty Tiptap doc — one empty paragraph. Asserting the
    // exact JSON shape protects future readers from "what does empty look like?"
    // confusion when adding revision diffs.
    expect(row?.document).toBe(
      JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }),
    );
  });

  it("fetches by slug scoped to language", async () => {
    const input = mkInput({ slug: "shared-slug", language: "en" });
    await createArticle(input);
    const heCollision = mkInput({ slug: "shared-slug", language: "he" });
    await createArticle(heCollision);
    const en = await getArticleBySlug("en", "shared-slug");
    const he = await getArticleBySlug("he", "shared-slug");
    expect(en?.id).toBe(input.id);
    expect(he?.id).toBe(heCollision.id);
    expect(en?.id).not.toBe(he?.id);
  });

  it("listArticlesSlim filters by status, type, language", async () => {
    // Two articles in distinct buckets to verify the WHERE composition.
    const draftFeatureEn = mkInput({
      slug: "filter-1",
      language: "en",
      type: "feature",
    });
    const reviewNewsHe = mkInput({
      slug: "filter-2",
      language: "he",
      type: "news",
    });
    await createArticle(draftFeatureEn);
    await createArticle(reviewNewsHe);
    await setArticleStatus(reviewNewsHe.id, "review");
    const onlyReview = await listArticlesSlim({ status: "review" });
    const onlyHebrew = await listArticlesSlim({ language: "he" });
    const onlyNews = await listArticlesSlim({ type: "news" });
    expect(onlyReview.some((r) => r.id === reviewNewsHe.id)).toBe(true);
    expect(onlyReview.every((r) => r.status === "review")).toBe(true);
    expect(onlyHebrew.every((r) => r.language === "he")).toBe(true);
    expect(onlyNews.every((r) => r.type === "news")).toBe(true);
  });
});

describe("articles repo / EDITABLE enforcement", () => {
  it("ignores fields not in the allow-list", async () => {
    const input = mkInput({ slug: "editable-1" });
    await createArticle(input);
    // `status`, `language`, `slug`, `id` are intentionally not editable via
    // updateArticle — they have their own writers (setArticleStatus,
    // updateArticleSlug) or are immutable. Throwing here would surprise the
    // caller; silently dropping them is the documented behavior.
    await updateArticle(input.id, {
      title: "New title",
      summary: "New summary",
      status: "published", // should NOT be written
      language: "he", // should NOT be written
      slug: "evil-slug", // should NOT be written
      id: "evil-id", // should NOT be written
    });
    const row = await getArticle(input.id);
    expect(row?.title).toBe("New title");
    expect(row?.summary).toBe("New summary");
    expect(row?.status).toBe("draft");
    expect(row?.language).toBe("en");
    expect(row?.slug).toBe("editable-1");
  });
});

describe("articles repo / slug collisions", () => {
  it("checkSlugAvailable returns true on empty", async () => {
    expect(await checkSlugAvailable("en", `fresh-${Date.now()}`)).toBe(true);
  });

  it("returns false when the same language already uses the slug", async () => {
    const input = mkInput({ slug: "collision-1", language: "en" });
    await createArticle(input);
    expect(await checkSlugAvailable("en", "collision-1")).toBe(false);
  });

  it("returns true when only the OTHER language uses the slug", async () => {
    const input = mkInput({ slug: "per-language", language: "en" });
    await createArticle(input);
    expect(await checkSlugAvailable("he", "per-language")).toBe(true);
  });

  it("excludeId lets an article re-save its own slug", async () => {
    const input = mkInput({ slug: "self-save", language: "en" });
    await createArticle(input);
    expect(await checkSlugAvailable("en", "self-save", input.id)).toBe(true);
  });

  it("updateArticleSlug persists the new slug", async () => {
    const input = mkInput({ slug: "old-slug" });
    await createArticle(input);
    await updateArticleSlug(input.id, "new-slug");
    const row = await getArticle(input.id);
    expect(row?.slug).toBe("new-slug");
  });
});

describe("articles repo / status transitions", () => {
  it("sets published_at when status flips to published", async () => {
    const input = mkInput({ slug: "publish-flow" });
    await createArticle(input);
    const before = await getArticle(input.id);
    expect(before?.published_at).toBeNull();
    await setArticleStatus(input.id, "published");
    const after = await getArticle(input.id);
    expect(after?.status).toBe("published");
    expect(after?.published_at).not.toBeNull();
    expect(after?.published_at?.length ?? 0).toBeGreaterThan(0);
  });

  it("does not overwrite published_at on later status changes", async () => {
    const input = mkInput({ slug: "publish-then-archive" });
    await createArticle(input);
    await setArticleStatus(input.id, "published");
    const published = await getArticle(input.id);
    const publishedAt = published?.published_at;
    await setArticleStatus(input.id, "archived");
    const archived = await getArticle(input.id);
    expect(archived?.status).toBe("archived");
    expect(archived?.published_at).toBe(publishedAt);
  });
});

describe("articles repo / revision coalescing", () => {
  it("coalesces a second save inside the window into the same row", async () => {
    const input = mkInput({ slug: "coalesce-1" });
    await createArticle(input);
    const first = await appendRevision({
      id: randomUUID(),
      article_id: input.id,
      document: "{}",
      payload: "{}",
      title: "first",
      status: "draft",
      author_id: null,
    });
    const second = await appendRevision({
      id: randomUUID(),
      article_id: input.id,
      document: "{\"v\":2}",
      payload: "{}",
      title: "second",
      status: "draft",
      author_id: null,
    });
    expect(first.coalesced).toBe(false);
    expect(second.coalesced).toBe(true);
    expect(second.revisionId).toBe(first.revisionId);
    const revs = await listRevisions(input.id);
    expect(revs.length).toBe(1);
    // The single row should reflect the latest write (title "second", new doc).
    expect(revs[0].title).toBe("second");
    expect(revs[0].document).toBe("{\"v\":2}");
  });

  it("inserts a new revision when the window is zero", async () => {
    const input = mkInput({ slug: "coalesce-2" });
    await createArticle(input);
    await appendRevision({
      id: randomUUID(),
      article_id: input.id,
      document: "{}",
      payload: "{}",
      title: "r1",
      status: "draft",
      author_id: null,
      coalesceWindowSec: 0,
    });
    await appendRevision({
      id: randomUUID(),
      article_id: input.id,
      document: "{}",
      payload: "{}",
      title: "r2",
      status: "draft",
      author_id: null,
      coalesceWindowSec: 0,
    });
    const revs = await listRevisions(input.id);
    expect(revs.length).toBe(2);
  });
});

describe("articles repo / delete", () => {
  it("hard-deletes the article and its revisions", async () => {
    const input = mkInput({ slug: "delete-me" });
    await createArticle(input);
    await appendRevision({
      id: randomUUID(),
      article_id: input.id,
      document: "{}",
      payload: "{}",
      title: "snap",
      status: "draft",
      author_id: null,
      coalesceWindowSec: 0,
    });
    await deleteArticle(input.id);
    const row = await getArticle(input.id);
    const revs = await listRevisions(input.id);
    expect(row).toBeNull();
    expect(revs.length).toBe(0);
  });
});
