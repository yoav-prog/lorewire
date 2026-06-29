// Integration test for the bulk reclassify service. Seeds three real
// stories (Drama, NULL, Humor) into the test DB, mocks the LLM helper to
// return deterministic classifications, then asserts:
//   - only the Drama + NULL rows are scanned (Humor untouched)
//   - successful classifications write the new category to the DB
//   - unchanged classifications report as "unchanged", no write
//   - LLM failures end up in `failed`, no write
//
// Mirrors poll-autodraft.test.ts: real `run`/`all` against the SQLite
// test DB plus `vi.spyOn(llm, "chatCompletion")` for the LLM seam. Plan:
// _plans/2026-06-21-category-classifier-and-pills.md.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, run } from "@/lib/db";
import * as llm from "@/lib/llm";
import { reclassifyDramaAndNullStories } from "@/lib/reclassify-stories";

async function reset(): Promise<void> {
  await run("DELETE FROM stories WHERE id LIKE 'test-rc-%'");
}

async function seedStory(
  id: string,
  category: string | null,
  body: string,
  title: string = "T",
): Promise<void> {
  const now = new Date().toISOString();
  // Categories that may be NULL go through a separate insert that omits
  // the column so SQLite stores NULL rather than the literal string.
  if (category === null) {
    await run(
      "INSERT INTO stories (id, title, status, body, created_at, updated_at) " +
        "VALUES (?, ?, 'review', ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      [id, title, body, now, now],
    );
  } else {
    await run(
      "INSERT INTO stories (id, category, title, status, body, created_at, updated_at) " +
        "VALUES (?, ?, ?, 'review', ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET category = excluded.category, body = excluded.body",
      [id, category, title, body, now, now],
    );
  }
}

beforeEach(async () => {
  await reset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("reclassifyDramaAndNullStories", () => {
  it("scans only Drama + NULL rows and ignores other categories", async () => {
    await seedStory("test-rc-drama-1", "Drama", "An office gift fund vanishes.");
    await seedStory("test-rc-null-1", null, "Two roommates and a sticky note war.");
    await seedStory("test-rc-humor-1", "Humor", "A passive-aggressive Wi-Fi name.");
    // The classifier always returns "Entitled" — but the Humor row should
    // never get to the classifier in the first place.
    const spy = vi
      .spyOn(llm, "chatCompletion")
      .mockResolvedValue({
        ok: true,
        content: "Entitled",
        provider: "openai",
        model: "gpt-5-nano",
      });

    const r = await reclassifyDramaAndNullStories();
    expect(r.scanned).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);

    const humor = await all<{ category: string | null }>(
      "SELECT category FROM stories WHERE id = ?",
      ["test-rc-humor-1"],
    );
    expect(humor[0].category).toBe("Humor");
  });

  it("writes the new category when the classifier returns a different value", async () => {
    await seedStory("test-rc-drama-2", "Drama", "A coworker steals tip money.");
    vi.spyOn(llm, "chatCompletion").mockResolvedValue({
      ok: true,
      content: "Entitled",
      provider: "openai",
      model: "gpt-5-nano",
    });

    const r = await reclassifyDramaAndNullStories();
    expect(r.reclassified).toBe(1);
    expect(r.changes[0]).toMatchObject({
      id: "test-rc-drama-2",
      prev: "Drama",
      next: "Entitled",
    });

    const row = await all<{ category: string | null }>(
      "SELECT category FROM stories WHERE id = ?",
      ["test-rc-drama-2"],
    );
    expect(row[0].category).toBe("Entitled");
  });

  it("counts unchanged when the classifier returns the same category", async () => {
    await seedStory("test-rc-drama-3", "Drama", "A neighbour's fence dispute.");
    vi.spyOn(llm, "chatCompletion").mockResolvedValue({
      ok: true,
      content: "Drama",
      provider: "openai",
      model: "gpt-5-nano",
    });

    const r = await reclassifyDramaAndNullStories();
    expect(r.reclassified).toBe(0);
    expect(r.unchanged).toBe(1);
    expect(r.changes).toHaveLength(0);

    const row = await all<{ category: string | null }>(
      "SELECT category FROM stories WHERE id = ?",
      ["test-rc-drama-3"],
    );
    expect(row[0].category).toBe("Drama");
  });

  it("collects failures when the LLM call errors", async () => {
    await seedStory(
      "test-rc-drama-4",
      "Drama",
      "An entitled airline passenger demands a window seat.",
    );
    vi.spyOn(llm, "chatCompletion").mockResolvedValue({
      ok: false,
      error: "openai 503: upstream",
    });

    const r = await reclassifyDramaAndNullStories();
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({
      id: "test-rc-drama-4",
      reason: expect.stringContaining("503"),
    });
    expect(r.reclassified).toBe(0);

    const row = await all<{ category: string | null }>(
      "SELECT category FROM stories WHERE id = ?",
      ["test-rc-drama-4"],
    );
    expect(row[0].category).toBe("Drama");
  });
});
