// Phase 1.5 tests for listContentSlim — the unified Stories + Articles feed
// that powers /admin/content. The two tables stay separate; this function
// merges, sorts, and filters in JS.

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { run } from "@/lib/db";
import {
  createArticle,
  listContentSlim,
  setArticleStatus,
} from "@/lib/repo";

// Stories don't have a CRUD helper exported from repo (they're written by
// the Python pipeline in normal use), so the test inserts via raw SQL. The
// shape mirrors what listStoriesSlim returns: id, slug, category, title,
// status, cost_cents, created_at, updated_at.
async function insertStory(opts: {
  title: string;
  category?: string;
  status?: string;
  updatedAt?: string;
}): Promise<string> {
  const id = randomUUID();
  const now = opts.updatedAt ?? new Date().toISOString();
  await run(
    "INSERT INTO stories (id, slug, category, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      `story-${id.slice(0, 6)}`,
      opts.category ?? "Entitled",
      opts.title,
      opts.status ?? "draft",
      now,
      now,
    ],
  );
  return id;
}

beforeAll(async () => {
  // Warm the lazy schema so the first insert below lands in a real table.
  await listContentSlim({ limit: 1 });
});

describe("listContentSlim / merge", () => {
  it("returns both stories and articles in one feed, sorted by updated_at desc", async () => {
    const older = "2026-06-10T10:00:00.000Z";
    const newer = "2026-06-11T10:00:00.000Z";
    const storyId = await insertStory({
      title: "Old video story",
      updatedAt: older,
    });
    const articleId = randomUUID();
    await createArticle({
      id: articleId,
      type: "feature",
      language: "en",
      slug: `merge-${articleId.slice(0, 6)}`,
      title: "New article",
      author_id: null,
    });
    // createArticle writes "now" — bump the article explicitly so the
    // ordering is deterministic without depending on millisecond timing.
    await run("UPDATE articles SET updated_at = ? WHERE id = ?", [
      newer,
      articleId,
    ]);
    const rows = await listContentSlim({ limit: 50 });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(storyId);
    expect(ids).toContain(articleId);
    const articleIdx = ids.indexOf(articleId);
    const storyIdx = ids.indexOf(storyId);
    expect(articleIdx).toBeLessThan(storyIdx);
  });

  it("stamps kind/subKind correctly per row", async () => {
    const rows = await listContentSlim({ limit: 200 });
    for (const r of rows) {
      if (r.kind === "story") {
        expect(r.subKind).toBe("video");
        expect(r.language).toBeNull();
      } else {
        expect(["news", "feature", "listicle", "review"]).toContain(r.subKind);
      }
    }
  });
});

describe("listContentSlim / filters", () => {
  it("subKind=video returns only stories", async () => {
    await insertStory({ title: "Filter story 1" });
    const articleId = randomUUID();
    await createArticle({
      id: articleId,
      type: "feature",
      language: "en",
      slug: `vid-filter-${articleId.slice(0, 6)}`,
      title: "Filter article",
      author_id: null,
    });
    const rows = await listContentSlim({ subKind: "video", limit: 50 });
    expect(rows.every((r) => r.kind === "story")).toBe(true);
    expect(rows.some((r) => r.id === articleId)).toBe(false);
  });

  it("subKind=news returns only news articles", async () => {
    const featureId = randomUUID();
    const newsId = randomUUID();
    await createArticle({
      id: featureId,
      type: "feature",
      language: "en",
      slug: `feat-${featureId.slice(0, 6)}`,
      title: "Feature",
      author_id: null,
    });
    await createArticle({
      id: newsId,
      type: "news",
      language: "en",
      slug: `news-${newsId.slice(0, 6)}`,
      title: "News",
      author_id: null,
    });
    const rows = await listContentSlim({ subKind: "news", limit: 50 });
    expect(rows.every((r) => r.kind === "article" && r.subKind === "news")).toBe(
      true,
    );
    expect(rows.some((r) => r.id === newsId)).toBe(true);
    expect(rows.some((r) => r.id === featureId)).toBe(false);
  });

  it("language filter narrows to articles only and the chosen language", async () => {
    const heId = randomUUID();
    const enId = randomUUID();
    await createArticle({
      id: heId,
      type: "feature",
      language: "he",
      slug: `lang-he-${heId.slice(0, 6)}`,
      title: "עברית",
      author_id: null,
    });
    await createArticle({
      id: enId,
      type: "feature",
      language: "en",
      slug: `lang-en-${enId.slice(0, 6)}`,
      title: "English",
      author_id: null,
    });
    await insertStory({ title: "A story that should be excluded" });
    const rows = await listContentSlim({ language: "he", limit: 50 });
    expect(rows.every((r) => r.kind === "article" && r.language === "he")).toBe(
      true,
    );
  });

  it("status filters across both kinds for shared statuses", async () => {
    const storyId = await insertStory({
      title: "Review story",
      status: "review",
    });
    const articleId = randomUUID();
    await createArticle({
      id: articleId,
      type: "feature",
      language: "en",
      slug: `rev-${articleId.slice(0, 6)}`,
      title: "Review article",
      author_id: null,
    });
    await setArticleStatus(articleId, "review");
    const rows = await listContentSlim({ status: "review", limit: 50 });
    expect(rows.some((r) => r.id === storyId)).toBe(true);
    expect(rows.some((r) => r.id === articleId)).toBe(true);
    expect(rows.every((r) => r.status === "review")).toBe(true);
  });

  it("video-only statuses (scripted) skip the articles fetch", async () => {
    const storyId = await insertStory({
      title: "Scripted story",
      status: "scripted",
    });
    const rows = await listContentSlim({ status: "scripted", limit: 50 });
    // Articles can't have status='scripted'. The function should still return
    // the matching story without crashing.
    expect(rows.every((r) => r.kind === "story")).toBe(true);
    expect(rows.some((r) => r.id === storyId)).toBe(true);
  });

  it("category filter narrows to matching stories and excludes articles", async () => {
    const humorId = await insertStory({
      title: "Humor story",
      category: "Humor",
    });
    const dramaId = await insertStory({
      title: "Drama story",
      category: "Drama",
    });
    const articleId = randomUUID();
    await createArticle({
      id: articleId,
      type: "feature",
      language: "en",
      slug: `cat-${articleId.slice(0, 6)}`,
      title: "An article (no category)",
      author_id: null,
    });
    const rows = await listContentSlim({ category: "Humor", limit: 50 });
    // Stories with category=Humor only; articles excluded entirely because
    // they carry no category column.
    expect(rows.every((r) => r.kind === "story")).toBe(true);
    expect(rows.some((r) => r.id === humorId)).toBe(true);
    expect(rows.some((r) => r.id === dramaId)).toBe(false);
    expect(rows.some((r) => r.id === articleId)).toBe(false);
  });
});
