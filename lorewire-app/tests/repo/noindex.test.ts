// Regression coverage for the per-row noindex flag on articles and stories.
// The flag is a single integer column with set/read paths through dedicated
// repo helpers; the SQL is trivial but the contract is load-bearing — a
// regression here means the public article reader either over-indexes
// private pieces or hides indexable ones.

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createArticle,
  getArticle,
  setArticleNoindex,
  setStoryNoindex,
  type StoryStatus,
} from "@/lib/repo";
import { all, run } from "@/lib/db";

async function makeArticleFixture(): Promise<string> {
  const id = randomUUID();
  await createArticle({
    id,
    type: "feature",
    language: "en",
    slug: `noindex-${id.slice(0, 6)}`,
    title: "Noindex test fixture",
    author_id: null,
  });
  return id;
}

async function makeStoryFixture(): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await run(
    "INSERT INTO stories (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [id, "Noindex story fixture", "draft" satisfies StoryStatus, now, now],
  );
  return id;
}

async function readStoryNoindex(id: string): Promise<number | null> {
  const rows = await all<{ noindex: number | null }>(
    "SELECT noindex FROM stories WHERE id = ?",
    [id],
  );
  return rows[0]?.noindex ?? null;
}

beforeAll(async () => {
  // Warm the schema before any test reaches into ALTER-added columns.
  await getArticle(randomUUID());
});

describe("setArticleNoindex", () => {
  it("flips the article column from default to 1 and back to 0", async () => {
    const id = await makeArticleFixture();
    const before = await getArticle(id);
    // Default is 0 or NULL — the helper writes 0/1 explicitly, never NULL.
    expect(before?.noindex ?? 0).toBe(0);

    await setArticleNoindex(id, true);
    const on = await getArticle(id);
    expect(on?.noindex).toBe(1);

    await setArticleNoindex(id, false);
    const off = await getArticle(id);
    expect(off?.noindex).toBe(0);
  });

  it("bumps updated_at on each toggle", async () => {
    const id = await makeArticleFixture();
    const initial = (await getArticle(id))?.updated_at ?? "";
    // Sleep a tick so the timestamp has time to change. The repo uses an
    // ISO-8601 string at millisecond precision, so 5ms is plenty.
    await new Promise((r) => setTimeout(r, 5));
    await setArticleNoindex(id, true);
    const after = (await getArticle(id))?.updated_at ?? "";
    expect(after).not.toBe(initial);
    expect(after > initial).toBe(true);
  });

  it("is idempotent — re-applying the same value still writes a row update", async () => {
    const id = await makeArticleFixture();
    await setArticleNoindex(id, true);
    const first = (await getArticle(id))?.updated_at ?? "";
    await new Promise((r) => setTimeout(r, 5));
    await setArticleNoindex(id, true);
    const second = (await getArticle(id))?.updated_at ?? "";
    // Idempotent on value, but updated_at still advances because the
    // helper bumps it unconditionally. That's the documented contract.
    expect(second > first).toBe(true);
  });
});

describe("setStoryNoindex", () => {
  it("flips the story column from default to 1 and back to 0", async () => {
    const id = await makeStoryFixture();
    expect((await readStoryNoindex(id)) ?? 0).toBe(0);

    await setStoryNoindex(id, true);
    expect(await readStoryNoindex(id)).toBe(1);

    await setStoryNoindex(id, false);
    expect(await readStoryNoindex(id)).toBe(0);
  });
});

describe("article SELECT includes noindex", () => {
  it("getArticle reads the column on a freshly-created article", async () => {
    const id = await makeArticleFixture();
    await setArticleNoindex(id, true);
    const row = await getArticle(id);
    expect(row).not.toBeNull();
    expect(row?.noindex).toBe(1);
  });
});
