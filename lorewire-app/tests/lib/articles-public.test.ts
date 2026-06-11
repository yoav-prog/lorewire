// Tests for the public read API. The load-bearing guarantee is that drafts
// never leak through — a caller that forgets to filter must still get only
// published rows. We also assert language/type filtering and the
// keyset-style published_at cursor.

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createArticle,
  setArticleStatus,
  updateArticle,
} from "@/lib/repo";
import {
  countPublishedArticles,
  getPublishedArticleBySlug,
  listPublishedArticles,
} from "@/lib/articles-public";
import { run } from "@/lib/db";

async function publishedFixture(opts: {
  language: "he" | "en";
  type?: "news" | "feature" | "listicle" | "review";
  slug?: string;
  title?: string;
  publishedAt?: string;
}): Promise<string> {
  const id = randomUUID();
  await createArticle({
    id,
    type: opts.type ?? "feature",
    language: opts.language,
    slug: opts.slug ?? `pub-${id.slice(0, 6)}`,
    title: opts.title ?? "Test title",
    author_id: null,
  });
  await setArticleStatus(id, "published");
  if (opts.publishedAt) {
    await run(
      "UPDATE articles SET published_at = ? WHERE id = ?",
      [opts.publishedAt, id],
    );
  }
  return id;
}

beforeAll(async () => {
  // Warm the lazy schema before the first insert.
  await listPublishedArticles({ limit: 1 });
});

describe("listPublishedArticles", () => {
  it("excludes drafts even when no status filter is passed", async () => {
    const draftId = randomUUID();
    await createArticle({
      id: draftId,
      type: "feature",
      language: "en",
      slug: `draft-${draftId.slice(0, 6)}`,
      title: "Should never appear",
      author_id: null,
    });
    const rows = await listPublishedArticles({ limit: 200 });
    expect(rows.every((r) => r.id !== draftId)).toBe(true);
  });

  it("excludes review/archived statuses too", async () => {
    const reviewId = randomUUID();
    await createArticle({
      id: reviewId,
      type: "feature",
      language: "en",
      slug: `rev-${reviewId.slice(0, 6)}`,
      title: "In review",
      author_id: null,
    });
    await setArticleStatus(reviewId, "review");
    const archiveId = await publishedFixture({ language: "en" });
    await setArticleStatus(archiveId, "archived");
    const rows = await listPublishedArticles({ limit: 200 });
    expect(rows.every((r) => r.id !== reviewId)).toBe(true);
    expect(rows.every((r) => r.id !== archiveId)).toBe(true);
  });

  it("filters by language", async () => {
    await publishedFixture({ language: "he", title: "עברית" });
    await publishedFixture({ language: "en", title: "English" });
    const onlyHebrew = await listPublishedArticles({ language: "he" });
    expect(onlyHebrew.every((r) => r.language === "he")).toBe(true);
  });

  it("filters by type", async () => {
    await publishedFixture({ language: "en", type: "news" });
    await publishedFixture({ language: "en", type: "review" });
    const onlyNews = await listPublishedArticles({ type: "news" });
    expect(onlyNews.every((r) => r.type === "news")).toBe(true);
  });

  it("orders results newest-first by published_at", async () => {
    await publishedFixture({
      language: "en",
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
    await publishedFixture({
      language: "en",
      publishedAt: "2026-05-01T00:00:00.000Z",
    });
    const rows = await listPublishedArticles({ language: "en", limit: 100 });
    const sortedManually = [...rows].sort((a, b) =>
      (b.published_at ?? "").localeCompare(a.published_at ?? ""),
    );
    expect(rows).toEqual(sortedManually);
  });

  it("paginates via beforePublishedAt", async () => {
    const aId = await publishedFixture({
      language: "en",
      publishedAt: "2026-03-01T00:00:00.000Z",
    });
    const bId = await publishedFixture({
      language: "en",
      publishedAt: "2026-03-02T00:00:00.000Z",
    });
    const second = await listPublishedArticles({
      language: "en",
      limit: 100,
      beforePublishedAt: "2026-03-02T00:00:00.000Z",
    });
    expect(second.some((r) => r.id === aId)).toBe(true);
    expect(second.every((r) => r.id !== bId)).toBe(true);
  });

  it("caps limit at 100", async () => {
    // Asking for a million returns at most 100 — the function clamps the
    // bound so a hostile caller can't drag the table out in one shot.
    const rows = await listPublishedArticles({ limit: 1_000_000 });
    expect(rows.length).toBeLessThanOrEqual(100);
  });
});

describe("getPublishedArticleBySlug", () => {
  it("returns the row when published", async () => {
    const id = await publishedFixture({
      language: "en",
      slug: "slug-found",
      title: "Findable",
    });
    const row = await getPublishedArticleBySlug("en", "slug-found");
    expect(row?.id).toBe(id);
  });

  it("returns null when the slug exists but is unpublished", async () => {
    const draftId = randomUUID();
    await createArticle({
      id: draftId,
      type: "feature",
      language: "en",
      slug: "slug-draft",
      title: "Hidden",
      author_id: null,
    });
    const row = await getPublishedArticleBySlug("en", "slug-draft");
    expect(row).toBeNull();
  });

  it("returns null for the wrong language even with matching slug", async () => {
    await publishedFixture({
      language: "en",
      slug: "shared-slug-name",
    });
    const row = await getPublishedArticleBySlug("he", "shared-slug-name");
    expect(row).toBeNull();
  });
});

describe("countPublishedArticles", () => {
  it("returns the count for a specific language", async () => {
    const before = await countPublishedArticles("en");
    await publishedFixture({ language: "en" });
    const after = await countPublishedArticles("en");
    expect(after - before).toBe(1);
  });
});
