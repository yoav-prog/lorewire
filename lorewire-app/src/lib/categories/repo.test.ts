// Integration test for the PR2 category tables. `seedCategories` populates
// the `categories` registry from the manifest; `backfillStoryPrimaryTags`
// gives each story one primary story_tag mapped from its stories.category
// label. Uses real run/all against the SQLite test DB (mirrors
// reclassify-stories.test.ts), with test-prefixed rows cleaned up around
// each case. Plan: _plans/2026-07-01-category-taxonomy-multitag.md.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  run,
  seedCategories,
  seedGranularCategories,
  backfillStoryPrimaryTags,
} from "@/lib/db";
import {
  getCategoryBySlug,
  getPrimaryTag,
  getStoriesForCategory,
  getStoryTags,
  listCategories,
  setStoryTags,
} from "@/lib/categories/repo";
import { CATEGORY_DEFS } from "@/lib/categories/manifest";
import { GRANULAR_CATEGORIES } from "@/lib/categories/granular";

const PFX = "test-ct-";

async function reset(): Promise<void> {
  await run(`DELETE FROM story_tags WHERE story_id LIKE '${PFX}%'`);
  await run(`DELETE FROM stories WHERE id LIKE '${PFX}%'`);
}

async function seedStory(id: string, category: string | null): Promise<void> {
  const now = new Date().toISOString();
  // A null category is inserted through a column-omitting statement so SQLite
  // stores NULL rather than the literal string (mirrors reclassify's helper).
  if (category === null) {
    await run(
      "INSERT INTO stories (id, title, status, created_at, updated_at) " +
        "VALUES (?, 'T', 'review', ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
      [id, now, now],
    );
  } else {
    await run(
      "INSERT INTO stories (id, category, title, status, created_at, updated_at) " +
        "VALUES (?, ?, 'T', 'review', ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET category = excluded.category",
      [id, category, now, now],
    );
  }
}

beforeEach(async () => {
  await reset();
  // The schema chain already seeds the registry; call it again to keep the
  // test self-contained and to exercise idempotency.
  await seedCategories();
});

afterEach(async () => {
  await reset();
});

describe("seedCategories (the legacy six)", () => {
  it("seeds the manifest six with their data; PR3 retires them to legacy", async () => {
    await seedCategories(); // idempotent
    for (const def of CATEGORY_DEFS) {
      const row = await getCategoryBySlug(def.slug);
      expect(row).not.toBeNull();
      expect(row?.label).toBe(def.label);
      expect(row?.color).toBe(def.color);
      expect(row?.glyph).toBe(def.glyph);
      expect(row?.rail_surface).toBe(def.railSurface);
      expect(row?.is_rail).toBe(1);
      // The granular seed (run in the schema chain) moves the six to legacy.
      expect(row?.status).toBe("legacy");
    }
    // Retired: excluded from the active list.
    const activeSlugs = (await listCategories()).map((c) => c.slug);
    for (const def of CATEGORY_DEFS) {
      expect(activeSlugs).not.toContain(def.slug);
    }
  });
});

describe("seedGranularCategories (the granular set)", () => {
  it("seeds all granular categories as active with their data (idempotent)", async () => {
    await seedGranularCategories(); // second run must no-op, not duplicate
    for (const c of GRANULAR_CATEGORIES) {
      const row = await getCategoryBySlug(c.slug);
      expect(row).not.toBeNull();
      expect(row?.label).toBe(c.label);
      expect(row?.color).toBe(c.color);
      expect(row?.is_rail).toBe(c.isRail ? 1 : 0);
      expect(row?.description).toBe(c.description);
      expect(row?.status).toBe("active");
    }
  });

  it("makes the active set exactly the granular set, none of the legacy six", async () => {
    const activeSlugs = (await listCategories()).map((c) => c.slug);
    for (const c of GRANULAR_CATEGORIES) expect(activeSlugs).toContain(c.slug);
    for (const def of CATEGORY_DEFS) expect(activeSlugs).not.toContain(def.slug);
  });

  it("marks exactly the eight rails among the active set", async () => {
    const railSlugs = (await listCategories())
      .filter((c) => c.is_rail === 1)
      .map((c) => c.slug)
      .sort();
    const expected = GRANULAR_CATEGORIES.filter((c) => c.isRail)
      .map((c) => c.slug)
      .sort();
    expect(railSlugs).toEqual(expected);
  });
});

describe("backfillStoryPrimaryTags", () => {
  it("gives each story one primary tag mapped from its category label", async () => {
    await seedStory(`${PFX}drama`, "Drama");
    await seedStory(`${PFX}entitled`, "Entitled");
    await backfillStoryPrimaryTags();

    const drama = await getPrimaryTag(`${PFX}drama`);
    expect(drama?.category_slug).toBe("drama");
    expect(drama?.is_primary).toBe(1);
    expect(drama?.source).toBe("migration");

    const entitled = await getPrimaryTag(`${PFX}entitled`);
    expect(entitled?.category_slug).toBe("entitled");
  });

  it("is idempotent: re-run adds nothing, exactly one primary per story", async () => {
    await seedStory(`${PFX}humor`, "Humor");
    await backfillStoryPrimaryTags();
    await backfillStoryPrimaryTags();
    const tags = await getStoryTags(`${PFX}humor`);
    expect(tags).toHaveLength(1);
    expect(tags[0].is_primary).toBe(1);
    expect(tags[0].category_slug).toBe("humor");
  });

  it("skips stories whose category matches no seeded category", async () => {
    await seedStory(`${PFX}bogus`, "NotARealCategory");
    await backfillStoryPrimaryTags();
    expect(await getPrimaryTag(`${PFX}bogus`)).toBeNull();
    expect(await getStoryTags(`${PFX}bogus`)).toHaveLength(0);
  });

  it("skips stories with a NULL category", async () => {
    await seedStory(`${PFX}null`, null);
    await backfillStoryPrimaryTags();
    expect(await getPrimaryTag(`${PFX}null`)).toBeNull();
  });
});

describe("setStoryTags (write path)", () => {
  it("writes one primary + extras, then rewrites without accumulation", async () => {
    await setStoryTags(`${PFX}w1`, [
      { slug: "family-feuds", confidence: 0.9 },
      { slug: "in-laws", confidence: 0.6 },
    ]);
    const tags = await getStoryTags(`${PFX}w1`);
    expect(tags).toHaveLength(2);
    expect(tags[0].category_slug).toBe("family-feuds");
    expect(tags[0].is_primary).toBe(1);
    expect(tags[0].source).toBe("llm");
    expect(tags[1].is_primary).toBe(0);

    await setStoryTags(`${PFX}w1`, [{ slug: "workplace", confidence: 0.8 }]);
    const after = await getStoryTags(`${PFX}w1`);
    expect(after).toHaveLength(1);
    expect(after[0].category_slug).toBe("workplace");
    expect(after[0].is_primary).toBe(1);
  });

  it("keeps exactly one primary after a rewrite", async () => {
    await setStoryTags(`${PFX}w2`, [
      { slug: "cheating-betrayal", confidence: 0.9 },
      { slug: "wedding-drama", confidence: 0.5 },
    ]);
    await setStoryTags(`${PFX}w2`, [
      { slug: "wedding-drama", confidence: 0.9 },
      { slug: "cheating-betrayal", confidence: 0.4 },
    ]);
    const primaries = (await getStoryTags(`${PFX}w2`)).filter(
      (t) => t.is_primary === 1,
    );
    expect(primaries).toHaveLength(1);
    expect(primaries[0].category_slug).toBe("wedding-drama");
  });
});

describe("getStoriesForCategory", () => {
  it("returns published stories tagged with the slug, primary-first, excluding unpublished", async () => {
    const now = new Date().toISOString();
    for (const [id, status] of [
      [`${PFX}g1`, "published"],
      [`${PFX}g2`, "published"],
      [`${PFX}g3`, "review"],
    ] as const) {
      await run(
        "INSERT INTO stories (id, title, status, created_at, updated_at) " +
          "VALUES (?, 'T', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status",
        [id, status, now, now],
      );
    }
    await setStoryTags(`${PFX}g1`, [{ slug: "neighbor-wars", confidence: 0.9 }]);
    await setStoryTags(`${PFX}g2`, [
      { slug: "roommate-hell", confidence: 0.9 },
      { slug: "neighbor-wars", confidence: 0.5 },
    ]);
    await setStoryTags(`${PFX}g3`, [{ slug: "neighbor-wars", confidence: 0.9 }]);

    const ids = (await getStoriesForCategory("neighbor-wars")).map((r) => r.id);
    expect(ids).toContain(`${PFX}g1`);
    expect(ids).toContain(`${PFX}g2`);
    expect(ids).not.toContain(`${PFX}g3`);
    // primary (g1) sorts before the secondary tag (g2)
    expect(ids.indexOf(`${PFX}g1`)).toBeLessThan(ids.indexOf(`${PFX}g2`));
  });
});
