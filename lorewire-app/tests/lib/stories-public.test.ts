// Tests for the public stories read API. Mirrors articles-public.test.ts:
// the load-bearing guarantee is that drafts never leak through, AND
// slug-less stories aren't reachable (they have no public URL by design).

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { run } from "@/lib/db";
import {
  countPublishedStories,
  getPublishedStoryBySlug,
  listPublishedStories,
} from "@/lib/stories-public";

async function insertStory(opts: {
  status: "draft" | "published" | "archived";
  slug?: string | null;
  title?: string;
  publishedAt?: string | null;
  category?: string;
}): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO stories
       (id, slug, category, title, status, created_at, updated_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.slug ?? null,
      opts.category ?? "Drama",
      opts.title ?? `Title ${id.slice(0, 6)}`,
      opts.status,
      now,
      now,
      opts.publishedAt ?? (opts.status === "published" ? now : null),
    ],
  );
  return id;
}

beforeAll(async () => {
  // Warm the lazy schema before the first insert.
  await listPublishedStories({ limit: 1 });
});

describe("listPublishedStories", () => {
  it("excludes drafts", async () => {
    const slug = `draft-${randomUUID().slice(0, 6)}`;
    await insertStory({ status: "draft", slug, title: "draft fixture" });
    const rows = await listPublishedStories({ limit: 500 });
    expect(rows.find((r) => r.slug === slug)).toBeUndefined();
  });

  it("excludes archived", async () => {
    const slug = `arc-${randomUUID().slice(0, 6)}`;
    await insertStory({
      status: "archived",
      slug,
      title: "archived fixture",
      publishedAt: new Date().toISOString(),
    });
    const rows = await listPublishedStories({ limit: 500 });
    expect(rows.find((r) => r.slug === slug)).toBeUndefined();
  });

  it("excludes published rows missing a slug (they have no public URL)", async () => {
    await insertStory({
      status: "published",
      slug: null,
      title: "slugless published",
    });
    const rows = await listPublishedStories({ limit: 500 });
    expect(rows.find((r) => r.title === "slugless published")).toBeUndefined();
  });

  it("returns published rows with slugs", async () => {
    const slug = `ok-${randomUUID().slice(0, 6)}`;
    await insertStory({
      status: "published",
      slug,
      title: "visible fixture",
    });
    const rows = await listPublishedStories({ limit: 500 });
    expect(rows.find((r) => r.slug === slug)).toBeDefined();
  });

  it("filters by category", async () => {
    const slug = `cat-${randomUUID().slice(0, 6)}`;
    await insertStory({
      status: "published",
      slug,
      category: "Humor",
      title: "humor fixture",
    });
    const rows = await listPublishedStories({ category: "Humor", limit: 500 });
    expect(rows.every((r) => r.category === "Humor")).toBe(true);
    expect(rows.find((r) => r.slug === slug)).toBeDefined();
  });
});

describe("getPublishedStoryBySlug", () => {
  it("returns null for an empty slug without hitting the database", async () => {
    const row = await getPublishedStoryBySlug("");
    expect(row).toBeNull();
  });

  it("returns null for a non-existent slug", async () => {
    const row = await getPublishedStoryBySlug("definitely-not-a-real-slug-xxxxx");
    expect(row).toBeNull();
  });

  it("returns null for a draft", async () => {
    const slug = `slug-draft-${randomUUID().slice(0, 6)}`;
    await insertStory({ status: "draft", slug });
    const row = await getPublishedStoryBySlug(slug);
    expect(row).toBeNull();
  });

  it("returns the row for a published story with a slug", async () => {
    const slug = `slug-pub-${randomUUID().slice(0, 6)}`;
    await insertStory({
      status: "published",
      slug,
      title: "Public fixture",
    });
    const row = await getPublishedStoryBySlug(slug);
    expect(row).not.toBeNull();
    expect(row?.title).toBe("Public fixture");
    expect(row?.status).toBe("published");
  });
});

describe("countPublishedStories", () => {
  it("returns a non-negative integer", async () => {
    const n = await countPublishedStories();
    expect(typeof n).toBe("number");
    expect(n).toBeGreaterThanOrEqual(0);
  });
});
