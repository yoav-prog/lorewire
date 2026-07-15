// Phase 1 tests for loadContentPage — the keyset-paginated, server-driven
// replacement for the 200-row listContentSlim cap (UNION ALL of stories +
// articles, compound cursor on (COALESCE(updated_at, created_at), id) DESC).
// Plan: _plans/2026-07-15-content-pagination-and-bulk-safety.md.
//
// The test DB accumulates across the file (no per-test reset), so every test
// seeds rows carrying a unique lowercase token in the title and queries with
// `q: token` to isolate its own rows from the shared pool.

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { run } from "@/lib/db";
import { createArticle, loadContentPage } from "@/lib/repo";

function token(): string {
  return `pgt${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function seedStory(opts: {
  tok: string;
  n: number;
  updatedAt: string;
  category?: string;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await run(
    "INSERT INTO stories (id, slug, category, title, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      `story-${id.slice(0, 6)}`,
      opts.category ?? "Entitled",
      `${opts.tok} story ${opts.n}`,
      opts.status ?? "draft",
      opts.updatedAt,
      opts.updatedAt,
    ],
  );
  return id;
}

async function seedArticle(opts: {
  tok: string;
  n: number;
  updatedAt: string;
  type?: "news" | "feature" | "listicle" | "review";
}): Promise<string> {
  const id = randomUUID();
  await createArticle({
    id,
    type: opts.type ?? "feature",
    language: "en",
    slug: `art-${id.slice(0, 6)}`,
    title: `${opts.tok} article ${opts.n}`,
    author_id: null,
  });
  // createArticle stamps "now"; override so ordering is deterministic.
  await run("UPDATE articles SET updated_at = ? WHERE id = ?", [
    opts.updatedAt,
    id,
  ]);
  return id;
}

/** Walk every page for a token and return the ids in page order + the total
 *  reported on the first page. Guards against a non-terminating cursor. */
async function collectPages(
  tok: string,
  pageLimit: number,
): Promise<{ ids: string[]; total: number | null; pages: number }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let total: number | null = null;
  let pages = 0;
  for (;;) {
    const page = await loadContentPage({
      q: tok,
      limit: pageLimit,
      cursor,
      withTotal: cursor === undefined,
    });
    if (cursor === undefined) total = page.total;
    pages += 1;
    for (const r of page.rows) ids.push(r.id);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    if (pages > 500) throw new Error("pagination did not terminate");
  }
  return { ids, total, pages };
}

beforeAll(async () => {
  // Warm the lazy schema so the first insert lands in a real table.
  await loadContentPage({ limit: 1 });
});

describe("loadContentPage / keyset pagination", () => {
  it("pages through a mixed feed with no skips or dupes, newest-first, correct total", async () => {
    const tok = token();
    // Six rows across both tables with strictly descending timestamps so the
    // expected order is unambiguous. Interleave stories + articles.
    const ids: string[] = [];
    ids.push(await seedStory({ tok, n: 1, updatedAt: "2026-06-06T00:00:00.000Z" }));
    ids.push(await seedArticle({ tok, n: 2, updatedAt: "2026-06-05T00:00:00.000Z" }));
    ids.push(await seedStory({ tok, n: 3, updatedAt: "2026-06-04T00:00:00.000Z" }));
    ids.push(await seedArticle({ tok, n: 4, updatedAt: "2026-06-03T00:00:00.000Z" }));
    ids.push(await seedStory({ tok, n: 5, updatedAt: "2026-06-02T00:00:00.000Z" }));
    ids.push(await seedArticle({ tok, n: 6, updatedAt: "2026-06-01T00:00:00.000Z" }));
    // ids are already in newest-first order by construction.

    const { ids: got, total, pages } = await collectPages(tok, 2);
    expect(total).toBe(6);
    expect(pages).toBe(3); // 6 rows / 2 per page
    expect(got).toHaveLength(6);
    expect(new Set(got).size).toBe(6); // no dupes
    expect(got).toEqual(ids); // exact newest-first order across the cursor
  });

  it("breaks ties by id DESC when timestamps are identical (no skip/dupe)", async () => {
    const tok = token();
    const same = "2026-06-15T12:00:00.000Z";
    const a = await seedStory({ tok, n: 1, updatedAt: same });
    const b = await seedStory({ tok, n: 2, updatedAt: same });
    const c = await seedArticle({ tok, n: 3, updatedAt: same });
    const expected = [a, b, c].sort((x, y) => (x < y ? 1 : -1)); // id DESC

    const { ids: got, total } = await collectPages(tok, 1); // one row per page
    expect(total).toBe(3);
    expect(got).toHaveLength(3);
    expect(new Set(got).size).toBe(3);
    expect(got).toEqual(expected);
  });

  it("returns the whole set in one page when limit exceeds the count, nextCursor null", async () => {
    const tok = token();
    await seedStory({ tok, n: 1, updatedAt: "2026-06-10T00:00:00.000Z" });
    await seedArticle({ tok, n: 2, updatedAt: "2026-06-09T00:00:00.000Z" });
    const page = await loadContentPage({ q: tok, limit: 100, withTotal: true });
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(2);
    expect(page.nextCursor).toBeNull();
  });
});

describe("loadContentPage / search", () => {
  it("is case-insensitive and matches title, slug, and status", async () => {
    const tok = token();
    const s = await seedStory({
      tok,
      n: 1,
      updatedAt: "2026-06-08T00:00:00.000Z",
    });
    // Query with an UPPERCASE token; the row title stores it lowercase.
    const page = await loadContentPage({ q: tok.toUpperCase(), limit: 50 });
    expect(page.rows.some((r) => r.id === s)).toBe(true);
    // A different token must not leak this row.
    const other = await loadContentPage({ q: token(), limit: 50 });
    expect(other.rows.some((r) => r.id === s)).toBe(false);
  });
});

describe("loadContentPage / column filters + pagination", () => {
  it("category filter keeps stories only and still paginates cleanly", async () => {
    const tok = token();
    const humor: string[] = [];
    humor.push(await seedStory({ tok, n: 1, updatedAt: "2026-06-04T00:00:00.000Z", category: "Humor" }));
    humor.push(await seedStory({ tok, n: 2, updatedAt: "2026-06-03T00:00:00.000Z", category: "Humor" }));
    humor.push(await seedStory({ tok, n: 3, updatedAt: "2026-06-02T00:00:00.000Z", category: "Humor" }));
    await seedStory({ tok, n: 4, updatedAt: "2026-06-01T00:00:00.000Z", category: "Drama" });
    await seedArticle({ tok, n: 5, updatedAt: "2026-06-05T00:00:00.000Z" });

    const ids: string[] = [];
    let cursor: string | undefined;
    let total: number | null = null;
    for (;;) {
      const page = await loadContentPage({
        q: tok,
        category: "Humor",
        limit: 2,
        cursor,
        withTotal: cursor === undefined,
      });
      if (cursor === undefined) total = page.total;
      expect(page.rows.every((r) => r.kind === "story")).toBe(true);
      for (const r of page.rows) ids.push(r.id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(total).toBe(3);
    expect(ids.sort()).toEqual([...humor].sort());
  });

  it("status filter matches across both kinds", async () => {
    const tok = token();
    const s = await seedStory({
      tok,
      n: 1,
      updatedAt: "2026-06-04T00:00:00.000Z",
      status: "review",
    });
    const a = await seedArticle({
      tok,
      n: 2,
      updatedAt: "2026-06-03T00:00:00.000Z",
    });
    await run("UPDATE articles SET status = 'review' WHERE id = ?", [a]);
    const page = await loadContentPage({ q: tok, status: "review", limit: 50, withTotal: true });
    expect(page.total).toBe(2);
    expect(page.rows.every((r) => r.status === "review")).toBe(true);
    expect(page.rows.map((r) => r.id).sort()).toEqual([s, a].sort());
  });
});

describe("loadContentPage / edge cases", () => {
  it("returns an empty page (not a throw) when nothing matches", async () => {
    const page = await loadContentPage({ q: token(), limit: 10, withTotal: true });
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.total).toBe(0);
  });

  it("treats a malformed cursor as the first page instead of throwing", async () => {
    const tok = token();
    await seedStory({ tok, n: 1, updatedAt: "2026-06-07T00:00:00.000Z" });
    const page = await loadContentPage({ q: tok, cursor: "not-a-cursor", limit: 50 });
    expect(page.rows).toHaveLength(1);
  });
});
