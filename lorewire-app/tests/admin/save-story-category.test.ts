// Tests for the saveStory category path (story editor Overview tab).
// Since the 2026-07-01 taxonomy arc the picker submits a DB-driven
// category label; saveStory must validate it against the `categories`
// table and pair the stories.category write with a primary story_tag
// write — skipping the tag would let syncStoryPrimaryCategory (db.ts
// boot chain) revert the label on the next boot.
//
// Mock set mirrors tests/admin/bulk-content-actions.test.ts: the admin
// guard, Next caching APIs, and the poll-autodraft side effect are
// mocked; everything else exercises the real repo against the
// per-process SQLite test DB (see tests/setup.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";

vi.mock("@/lib/dal", () => {
  const session = {
    userId: "test-user",
    email: "test@lorewire.local",
    role: "admin",
  };
  return {
    requireAdmin: vi.fn().mockResolvedValue(session),
    requireCapability: vi.fn().mockResolvedValue(session),
    requireStaff: vi.fn().mockResolvedValue(session),
    ensureSeedAdmin: vi.fn().mockResolvedValue(null),
    currentUser: vi.fn().mockResolvedValue(null),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/poll-autodraft", () => ({
  autoDraftPollForSubject: vi.fn().mockResolvedValue(null),
}));

// Import AFTER vi.mock so the action module picks up the mocked deps.
import { saveStory } from "@/app/admin/actions";

interface StoryTagRow {
  category_slug: string;
  is_primary: number;
  source: string | null;
}

async function seedStory(category: string | null): Promise<string> {
  const id = randomUUID();
  await run(
    "INSERT INTO stories (id, slug, title, status, category, body, created_at, updated_at) " +
      "VALUES (?, ?, ?, 'draft', ?, 'short body', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z')",
    [id, `story-${id.slice(0, 6)}`, "Test story", category],
  );
  return id;
}

function form(id: string, category: string, title = "Edited title"): FormData {
  const fd = new FormData();
  fd.set("id", id);
  fd.set("title", title);
  fd.set("category", category);
  fd.set("duration", "0:52");
  fd.set("source_url", "https://example.com/src");
  fd.set("summary", "A summary.");
  fd.set("body", "short body");
  fd.set("teleprompter", "");
  return fd;
}

async function storyTags(id: string): Promise<StoryTagRow[]> {
  return all<StoryTagRow>(
    "SELECT category_slug, is_primary, source FROM story_tags WHERE story_id = ? " +
      "ORDER BY is_primary DESC, category_slug ASC",
    [id],
  );
}

async function storyCategory(id: string): Promise<string | null> {
  const row = await one<{ category: string | null }>(
    "SELECT category FROM stories WHERE id = ?",
    [id],
  );
  return row?.category ?? null;
}

describe("saveStory category write", () => {
  beforeEach(async () => {
    await run("DELETE FROM stories WHERE 1=1", []);
    await run("DELETE FROM story_tags WHERE 1=1", []);
  });

  it("writes stories.category AND the primary story_tag for a granular pick", async () => {
    const id = await seedStory("Drama");
    await saveStory(form(id, "Family Feuds"));

    expect(await storyCategory(id)).toBe("Family Feuds");
    const tags = await storyTags(id);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({
      category_slug: "family-feuds",
      is_primary: 1,
      source: "admin",
    });
  });

  it("promotes an existing non-primary tag instead of duplicating it", async () => {
    const id = await seedStory("Drama");
    await run(
      "INSERT INTO story_tags (story_id, category_slug, is_primary, source, created_at) " +
        "VALUES (?, 'in-laws', 1, 'llm', '2026-07-02T00:00:00.000Z'), " +
        "(?, 'wedding-drama', 0, 'llm', '2026-07-02T00:00:00.000Z')",
      [id, id],
    );

    await saveStory(form(id, "Wedding Drama"));

    expect(await storyCategory(id)).toBe("Wedding Drama");
    const tags = await storyTags(id);
    expect(tags).toHaveLength(2);
    const primaries = tags.filter((t) => t.is_primary === 1);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].category_slug).toBe("wedding-drama");
  });

  it("leaves tags alone when the category is unchanged", async () => {
    const id = await seedStory("Entitled People");
    await run(
      "INSERT INTO story_tags (story_id, category_slug, is_primary, source, created_at) " +
        "VALUES (?, 'entitled-people', 1, 'llm', '2026-07-02T00:00:00.000Z')",
      [id],
    );

    await saveStory(form(id, "Entitled People"));

    // The llm-sourced tag must not be rewritten to source='admin'.
    const tags = await storyTags(id);
    expect(tags).toHaveLength(1);
    expect(tags[0].source).toBe("llm");
  });

  it("rejects an unknown category but still saves the other fields", async () => {
    const id = await seedStory("Drama");
    await saveStory(form(id, "NotARealCategory", "New title"));

    expect(await storyCategory(id)).toBe("Drama");
    expect(await storyTags(id)).toHaveLength(0);
    const row = await one<{ title: string }>(
      "SELECT title FROM stories WHERE id = ?",
      [id],
    );
    expect(row?.title).toBe("New title");
  });

  it("keeps an uncategorized story uncategorized when nothing is picked", async () => {
    const id = await seedStory(null);
    await saveStory(form(id, ""));

    expect(await storyCategory(id)).toBeNull();
    expect(await storyTags(id)).toHaveLength(0);
  });
});
