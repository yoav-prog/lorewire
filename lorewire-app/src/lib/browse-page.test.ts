// loadBrowsePage powers the desktop Browse grid's cursor pagination. Before it
// existed, Browse read the shared 200-row homepage catalog and silently capped
// at ~201 titles once production passed 200 stories. These tests pin the four
// things that fix demands: it pages the WHOLE eligible catalog, its compound
// keyset cursor neither skips nor duplicates rows that share a timestamp, the
// category filter restricts both the page and the total, and the public gate
// matches loadLiveCatalog (plus a hero/video media requirement).
//
// Seeds the empty test SQLite the same way homepage-data-duration.test.ts does.
// Plan: _plans/2026-07-14-browse-pagination.md.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "@/lib/db";

vi.mock("@/lib/poll-cookie", () => ({
  readVoteToken: async () => null,
}));
vi.mock("@/lib/user-session", () => ({
  readUserSession: async () => null,
}));
vi.mock("@/lib/impersonation", () => ({
  resolveImpersonation: async () => null,
}));

async function reset(): Promise<void> {
  await run("DELETE FROM short_renders WHERE 1=1", []);
  await run("DELETE FROM stories WHERE 1=1", []);
}

interface SeedOpts {
  category?: string;
  status?: string;
  publishedAt?: string;
  slug?: string | null;
  noindex?: number | null;
  heroImage?: string | null;
  videoUrl?: string | null;
}

// Distinct default timestamps per call so the DESC order is deterministic
// unless a test deliberately collides them. Later `seq` => newer story.
async function seedStory(id: string, seq: number, opts: SeedOpts = {}): Promise<void> {
  const publishedAt =
    opts.publishedAt ??
    `2026-06-${String(10 + seq).padStart(2, "0")}T00:00:00.000Z`;
  await run(
    "INSERT INTO stories (id, slug, title, category, summary, status, " +
      "hero_image, video_url, noindex, created_at, published_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      opts.slug === undefined ? `slug-${id}` : opts.slug,
      `Title ${id}`,
      opts.category ?? "Drama",
      "synopsis",
      opts.status ?? "published",
      opts.heroImage === undefined ? `https://gcs/${id}-hero.jpg` : opts.heroImage,
      opts.videoUrl ?? null,
      opts.noindex ?? null,
      publishedAt,
      publishedAt,
    ],
  );
}

beforeEach(async () => {
  await reset();
});
afterEach(async () => {
  await reset();
});

describe("loadBrowsePage pagination", () => {
  it("pages the full catalog with a stable cursor and reports the true total", async () => {
    // 5 stories, page size 2 => pages of 2, 2, 1.
    for (let i = 0; i < 5; i++) await seedStory(`s${i}`, i);
    const { loadBrowsePage } = await import("@/lib/homepage-data");

    const p1 = await loadBrowsePage({ limit: 2, withTotal: true });
    expect(p1.ok).toBe(true);
    expect(p1.total).toBe(5);
    expect(p1.stories.map((s) => s.id)).toEqual(["s4", "s3"]); // newest first
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await loadBrowsePage({ limit: 2, beforeCursor: p1.nextCursor });
    expect(p2.total).toBeNull(); // only the first page carries the count
    expect(p2.stories.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(p2.nextCursor).not.toBeNull();

    const p3 = await loadBrowsePage({ limit: 2, beforeCursor: p2.nextCursor });
    expect(p3.stories.map((s) => s.id)).toEqual(["s0"]);
    expect(p3.nextCursor).toBeNull(); // final page

    // Union across pages is every story exactly once — no skips, no dupes.
    const all = [...p1.stories, ...p2.stories, ...p3.stories].map((s) => s.id);
    expect(new Set(all).size).toBe(5);
    expect(all.length).toBe(5);
  });

  it("does not skip or duplicate rows that share a timestamp (compound cursor)", async () => {
    // All four rows collide on published_at; only the id tiebreak separates
    // them. A single-column cursor would drop or repeat the boundary rows.
    const ts = "2026-06-20T00:00:00.000Z";
    for (const id of ["a", "b", "c", "d"]) await seedStory(id, 0, { publishedAt: ts });
    const { loadBrowsePage } = await import("@/lib/homepage-data");

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page = await loadBrowsePage({ limit: 2, beforeCursor: cursor });
      seen.push(...page.stories.map((s) => s.id));
      cursor = page.nextCursor;
    } while (cursor !== null && guard++ < 10);

    expect(seen.sort()).toEqual(["a", "b", "c", "d"]);
    expect(new Set(seen).size).toBe(4); // each exactly once
  });
});

describe("loadBrowsePage category filter", () => {
  it("restricts the page AND the total to the selected categories", async () => {
    await seedStory("d1", 0, { category: "Drama" });
    await seedStory("d2", 1, { category: "Drama" });
    await seedStory("h1", 2, { category: "Humor" });
    await seedStory("n1", 3, { category: "Neighbor Wars" });
    const { loadBrowsePage } = await import("@/lib/homepage-data");

    const drama = await loadBrowsePage({ limit: 50, categories: ["Drama"], withTotal: true });
    expect(drama.total).toBe(2);
    expect(drama.stories.map((s) => s.id).sort()).toEqual(["d1", "d2"]);

    const multi = await loadBrowsePage({
      limit: 50,
      categories: ["Humor", "Neighbor Wars"],
      withTotal: true,
    });
    expect(multi.total).toBe(2);
    expect(multi.stories.map((s) => s.id).sort()).toEqual(["h1", "n1"]);
  });
});

describe("loadBrowsePage public gate", () => {
  it("excludes review status, null slug, noindex, and rows with no hero or video", async () => {
    await seedStory("ok", 5); // has hero, published, slug => visible
    await seedStory("review", 4, { status: "review" });
    await seedStory("noslug", 3, { slug: null });
    await seedStory("hidden", 2, { noindex: 1 });
    await seedStory("artless", 1, { heroImage: null, videoUrl: null });
    // A ready (not yet published) story WITH a video still counts.
    await seedStory("readyvid", 6, { status: "ready", heroImage: null, videoUrl: "https://gcs/v.mp4" });
    const { loadBrowsePage } = await import("@/lib/homepage-data");

    const page = await loadBrowsePage({ limit: 50, withTotal: true });
    expect(page.total).toBe(2);
    expect(page.stories.map((s) => s.id).sort()).toEqual(["ok", "readyvid"]);
  });
});
