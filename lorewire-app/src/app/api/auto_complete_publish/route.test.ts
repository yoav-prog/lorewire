// @vitest-environment node

// Cron drain for the bulk Complete-&-publish flag. These tests pin the
// 2026-07-19 hero/thumbnail self-heal backstop: when a flagged story's only
// blocking gap is a card thumbnail, the cron enqueues the 5-variant finisher
// (hero_thumbnail_from_short) — and does so at most once at a time, because
// the image queue is not idempotent.
//
// Plan: _plans/2026-07-19-asset-incomplete-thumbnail-heal.md.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";

// poll-autodraft pulls in models + Anthropic config at import time; the cron
// only calls it on the poll-only stuck path, which these tests never hit.
vi.mock("@/lib/poll-autodraft", () => ({
  autoDraftPollForSubject: vi.fn().mockResolvedValue({ ok: false, ai: false }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { GET } from "./route";

const CRON_SECRET = "test-cron-secret";

function tick(): Promise<Response> {
  const req = new Request("https://x/api/auto_complete_publish", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  return GET(req as unknown as Parameters<typeof GET>[0]) as unknown as Promise<Response>;
}

async function reset(): Promise<void> {
  await run("DELETE FROM stories WHERE 1=1", []);
  await run("DELETE FROM short_renders WHERE 1=1", []);
  await run("DELETE FROM polls WHERE 1=1", []);
  await run("DELETE FROM image_renders WHERE 1=1", []);
  await run("DELETE FROM story_jobs WHERE 1=1", []);
  await run("DELETE FROM reddit_source WHERE 1=1", []);
}

/** A flagged story that passes every publish gate EXCEPT thumbnail_image:
 *  body + hero + done short + video_url + enabled poll present. So
 *  completeness.blocking === ["thumbnail_image"] and the cron's hero/thumbnail
 *  backstop is the only thing that can move it. `withShort` toggles the done
 *  short render the finisher needs to seed from. */
async function seedFlaggedThumbnailMiss(
  opts: { withShort?: boolean } = {},
): Promise<string> {
  const withShort = opts.withShort !== false;
  const id = randomUUID();
  await run(
    "INSERT INTO stories (id, slug, title, status, category, body, video_url, " +
      "hero_image, hero_image_landscape, thumbnail_image, " +
      "auto_publish_when_ready, created_at, updated_at) " +
      "VALUES (?, ?, 'Title', 'ready', 'Drama', 'a body long enough to matter', " +
      "'https://example.com/short.mp4', 'https://example.com/hero.png', " +
      "'https://example.com/hero-l.png', NULL, 1, " +
      "'2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z')",
    [id, `story-${id.slice(0, 6)}`],
  );
  if (withShort) {
    await run(
      "INSERT INTO short_renders (id, story_id, status, output_url, props, requested_at) " +
        "VALUES (?, ?, 'done', 'https://example.com/short.mp4', '{}', '2026-07-19T00:00:00.000Z')",
      [`${id}-short`, id],
    );
  }
  await run(
    "INSERT INTO polls (id, story_id, article_id, question, option_a_text, option_b_text, " +
      "enabled, category, created_at, updated_at) " +
      "VALUES (?, ?, NULL, 'Who is right?', 'A', 'B', 1, 'Drama', " +
      "'2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z')",
    [`${id}-poll`, id],
  );
  return id;
}

describe("/api/auto_complete_publish hero/thumbnail backstop", () => {
  beforeEach(async () => {
    process.env.CRON_SECRET = CRON_SECRET;
    await reset();
  });

  it("enqueues the hero+thumbnail finisher for a thumbnail-only blocker", async () => {
    const storyId = await seedFlaggedThumbnailMiss();

    const res = await tick();
    expect(res.status).toBe(200);

    const renders = await all<{ asset: string; status: string }>(
      "SELECT asset, status FROM image_renders WHERE owner_id = ?",
      [storyId],
    );
    expect(renders).toHaveLength(1);
    expect(renders[0].asset).toBe("hero_thumbnail_from_short");
    // Story stays flagged and unpublished — the render hasn't landed yet.
    const story = await one<{ status: string; auto_publish_when_ready: number }>(
      "SELECT status, auto_publish_when_ready FROM stories WHERE id = ?",
      [storyId],
    );
    expect(story!.status).toBe("ready");
    expect(story!.auto_publish_when_ready).toBe(1);
  });

  it("does not stack a second finisher while one is in flight", async () => {
    const storyId = await seedFlaggedThumbnailMiss();

    await tick(); // enqueues one (status 'queued' = in flight)
    await tick(); // must see the in-flight render and skip

    const renders = await all("SELECT id FROM image_renders WHERE owner_id = ?", [
      storyId,
    ]);
    expect(renders).toHaveLength(1);
  });

  it("skips the heal when there's no completed short to seed from", async () => {
    const storyId = await seedFlaggedThumbnailMiss({ withShort: false });

    await tick();

    const renders = await all("SELECT id FROM image_renders WHERE owner_id = ?", [
      storyId,
    ]);
    expect(renders).toHaveLength(0);
  });
});
