// Tests for publishStoryIfReady. The helper is the Full-Pipeline cron's
// drop-in equivalent of publishReviewedStoryAction's gate-+-flip body —
// it MUST reject for every reason the manual action rejects (so a
// human-blocked row also fails to auto-publish) and MUST flip status +
// autocurate on the happy path so the public site sees the new story
// without a manual click.
//
// 2026-06-25 (#101 follow-up): the helper now runs evaluateAssetCompleteness
// instead of evaluatePublishReadiness, so the fixture must seed the full
// asset chain (short, thumbnails, poll) for the happy-path tests. Tests
// that exercise a specific failure mode null out just that asset on
// top of the fully-seeded baseline.
//
// Plan: _plans/2026-06-24-reddit-source-full-pipeline-toggle.md +
// _plans/2026-06-25-bulk-complete-and-publish.md follow-up.

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

// Stub the poll-autodraft self-heal path — its real implementation
// reaches the LLM and we don't want network in unit tests. The
// poll-only retry composes correctness from the autodraft module's
// own tests; here we only need to know it's CALLED and it doesn't
// itself raise. Returning ok:true keeps the gate satisfied for the
// upgrade-existing-draft scenario; ok:false leaves the missing list
// intact for the draft-never-happened scenario. Tests below mock
// per-case as needed.
vi.mock("@/lib/poll-autodraft", () => ({
  autoDraftPollForSubject: vi.fn(async () => ({ ok: true, ai: true })),
}));

async function reset(): Promise<void> {
  await run("DELETE FROM homepage_curation WHERE 1=1", []);
  await run("DELETE FROM polls WHERE 1=1", []);
  await run("DELETE FROM short_renders WHERE 1=1", []);
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
  // Seed every column the asset gate now checks: 5 hero/thumbnail
  // variants on the story row + a done short_renders row + a
  // short_config with a non-empty voiceover_url and at least one
  // frame so the short_render gate passes. The voiceover/scene_images
  // gates are SUPPRESSED when short_render is present (per #100), so
  // we only need short_config minimal enough to round-trip parsing.
  const shortConfig = JSON.stringify({
    config_version: 1,
    doodle_frames: [
      { id: "frame-00", url: "https://example.com/scene-00.png", caption_chunk_start_index: 0 },
    ],
    captions: [],
    voiceover_url: "https://example.com/voice.mp3",
  });
  await run(
    "INSERT INTO stories (id, reddit_id, status, body, hero_image, " +
      "hero_image_landscape, thumbnail_image, thumbnail_image_landscape, " +
      "thumbnail_image_square, short_config, " +
      "created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, " +
      "'2026-06-24T00:00:00+00:00', '2026-06-24T00:00:00+00:00')",
    [
      storyId,
      redditId,
      status,
      body,
      hero,
      "https://example.com/hero-landscape.png",
      "https://example.com/thumb.png",
      "https://example.com/thumb-landscape.png",
      "https://example.com/thumb-square.png",
      shortConfig,
    ],
  );
  // Done short_renders row — the gate looks for status='done' AND
  // output_url AND props IS NOT NULL.
  await run(
    "INSERT INTO short_renders (id, story_id, status, output_url, props, requested_at) " +
      "VALUES (?, ?, 'done', ?, ?, '2026-06-24T00:00:00+00:00')",
    [
      `${storyId}-short`,
      storyId,
      "https://example.com/short.mp4",
      "{}",
    ],
  );
  // Enabled poll with a question — the gate requires enabled=1 AND
  // non-empty question.
  await run(
    "INSERT INTO polls (id, story_id, article_id, question, option_a_text, option_b_text, " +
      "enabled, category, created_at, updated_at) " +
      "VALUES (?, ?, NULL, 'Who is right?', 'A', 'B', 1, 'Drama', " +
      "'2026-06-24T00:00:00+00:00', '2026-06-24T00:00:00+00:00')",
    [`${storyId}-poll`, storyId],
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
      expect(result.missing).toContain("body");
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
      expect(result.missing).toContain("hero_image");
    }
  });

  it("rejects an already-published story (idempotency on the drain)", async () => {
    await seedSourceWithUsedStory("r-1", "s-1", { status: "published" });

    const result = await publishStoryIfReady("r-1");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.missing).toContain("already_published");
    }
  });

  it("rejects when the source is still 'imported' (worker hadn't finished)", async () => {
    // Edge case: worker bug somehow set auto_publish_status='pending'
    // before the source flipped to 'used'. The gate must still catch
    // this — the source-row has no story_id, so we return story_not_found.
    await run(
      "INSERT INTO reddit_source (reddit_id, subreddit, date_written, title, full_text, comments, status, story_id, first_synced, last_synced) " +
        "VALUES (?, 'AITAH', '2026-01-01T00:00:00+00:00', 't', 'f', 1, 'imported', NULL, '2026-06-24T00:00:00+00:00', '2026-06-24T00:00:00+00:00')",
      ["r-1"],
    );

    const result = await publishStoryIfReady("r-1");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("story_not_found");
    }
  });

  it("publishes the story exactly once on a repeat call (second call rejects with already_published)", async () => {
    await seedSourceWithUsedStory("r-1", "s-1");

    const first = await publishStoryIfReady("r-1");
    expect(first.ok).toBe(true);

    const second = await publishStoryIfReady("r-1");
    expect(second.ok).toBe(false);
    if (second.ok === false) {
      expect(second.missing).toContain("already_published");
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
