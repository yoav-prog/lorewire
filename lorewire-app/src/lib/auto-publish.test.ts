// Tests for publishStoryIfReady. The helper is the Full-Pipeline cron's
// drop-in equivalent of publishReviewedStoryAction's gate-+-flip body —
// it MUST reject for every reason the manual action rejects (so a
// human-blocked row also fails to auto-publish) and MUST flip status +
// autocurate on the happy path so the public site sees the new story
// without a manual click.
//
// Plan: _plans/2026-06-24-reddit-source-full-pipeline-toggle.md.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { all, one, run } from "@/lib/db";
import { publishStoryIfReady } from "./auto-publish";

// next/cache::revalidatePath is only callable in a Next render context;
// in vitest it throws "static generation store missing". The helper calls
// it after the status flip, but the flip itself is what we assert here.
// Mock to a no-op so the test exercises the SQL writes without the
// runtime context dependency.
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

async function reset(): Promise<void> {
  await run("DELETE FROM homepage_curation WHERE 1=1", []);
  await run("DELETE FROM stories WHERE 1=1", []);
  await run("DELETE FROM reddit_source WHERE 1=1", []);
}

async function seedSourceWithUsedStory(
  redditId: string,
  storyId: string,
  storyPatch: Partial<{
    status: string;
    body: string;
    hero_image: string | null;
  }> = {},
): Promise<void> {
  await run(
    "INSERT INTO reddit_source (reddit_id, subreddit, date_written, title, full_text, comments, status, story_id, first_synced, last_synced) " +
      "VALUES (?, 'AITAH', '2026-01-01T00:00:00+00:00', 't', 'f', 1, 'used', ?, '2026-06-24T00:00:00+00:00', '2026-06-24T00:00:00+00:00')",
    [redditId, storyId],
  );
  const status = storyPatch.status ?? "review";
  const body = storyPatch.body ?? "Article body that satisfies the gate.";
  const hero =
    storyPatch.hero_image === undefined
      ? "https://example.com/hero.png"
      : storyPatch.hero_image;
  await run(
    "INSERT INTO stories (id, reddit_id, status, body, hero_image, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, '2026-06-24T00:00:00+00:00', '2026-06-24T00:00:00+00:00')",
    [storyId, redditId, status, body, hero],
  );
}

beforeEach(reset);

describe("publishStoryIfReady", () => {
  it("flips story to published when source is 'used' + every artifact present", async () => {
    await seedSourceWithUsedStory("r-1", "s-1");

    const result = await publishStoryIfReady("r-1");

    expect(result).toEqual({ ok: true, storyId: "s-1" });
    const row = await one<{ status: string }>(
      "SELECT status FROM stories WHERE id=?",
      ["s-1"],
    );
    expect(row?.status).toBe("published");
  });

  it("rejects with source_not_found when the reddit_id is unknown", async () => {
    const result = await publishStoryIfReady("ghost");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("source_not_found");
    }
  });

  it("rejects with not_ready when the linked story has no body", async () => {
    await seedSourceWithUsedStory("r-1", "s-1", { body: "" });

    const result = await publishStoryIfReady("r-1");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("not_ready");
      expect(result.missing).toEqual(
        expect.arrayContaining([expect.stringMatching(/body/i)]),
      );
    }
    // Story should NOT have been flipped.
    const row = await one<{ status: string }>(
      "SELECT status FROM stories WHERE id=?",
      ["s-1"],
    );
    expect(row?.status).toBe("review");
  });

  it("rejects with not_ready when the linked story has no hero_image", async () => {
    await seedSourceWithUsedStory("r-1", "s-1", { hero_image: null });

    const result = await publishStoryIfReady("r-1");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.missing).toEqual(
        expect.arrayContaining([expect.stringMatching(/hero/i)]),
      );
    }
  });

  it("rejects an already-published story (idempotency on the drain)", async () => {
    await seedSourceWithUsedStory("r-1", "s-1", { status: "published" });

    const result = await publishStoryIfReady("r-1");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.missing).toEqual(
        expect.arrayContaining([expect.stringMatching(/already published/i)]),
      );
    }
  });

  it("rejects when the source is still 'imported' (worker hadn't finished)", async () => {
    // Edge case: worker bug somehow set auto_publish_status='pending'
    // before the source flipped to 'used'. The gate must still catch
    // this — it's the safety belt mentioned in store.py.
    await run(
      "INSERT INTO reddit_source (reddit_id, subreddit, date_written, title, full_text, comments, status, story_id, first_synced, last_synced) " +
        "VALUES (?, 'AITAH', '2026-01-01T00:00:00+00:00', 't', 'f', 1, 'imported', NULL, '2026-06-24T00:00:00+00:00', '2026-06-24T00:00:00+00:00')",
      ["r-1"],
    );

    const result = await publishStoryIfReady("r-1");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("not_ready");
    }
  });

  it("publishes the story exactly once on a repeat call (second call rejects with already-published)", async () => {
    await seedSourceWithUsedStory("r-1", "s-1");

    const first = await publishStoryIfReady("r-1");
    expect(first.ok).toBe(true);

    const second = await publishStoryIfReady("r-1");
    expect(second.ok).toBe(false);
    if (second.ok === false) {
      expect(second.missing).toEqual(
        expect.arrayContaining([expect.stringMatching(/already published/i)]),
      );
    }

    // status didn't bounce back.
    const row = await one<{ status: string }>(
      "SELECT status FROM stories WHERE id=?",
      ["s-1"],
    );
    expect(row?.status).toBe("published");
    // Lint: assert SQL has only one row in stories so the helper didn't
    // accidentally write a second copy.
    const count = await all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM stories WHERE id=?",
      ["s-1"],
    );
    expect(Number(count[0]?.n ?? 0)).toBe(1);
  });
});
