// Tests for the bulk complete-and-publish asset gate.
//
// Each test seeds the minimum state needed to flip ONE gate so a
// failure points at the gate the test is named for instead of "some
// fixture broke." The all-green test confirms the gate composes
// correctly across every check (regression catch if a future
// asset gate is added without updating the test).
//
// Plan: _plans/2026-06-25-bulk-complete-and-publish.md.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "@/lib/db";
import { evaluateAssetCompleteness } from "@/lib/asset-completeness";

const STORY_ID = "test-ac-story";
const RENDER_ID = "test-ac-render";
const POLL_ID = "test-ac-poll";

interface SeedOverrides {
  body?: string | null;
  hero_image?: string | null;
  hero_image_landscape?: string | null;
  thumbnail_image?: string | null;
  thumbnail_image_landscape?: string | null;
  thumbnail_image_square?: string | null;
  status?: string;
  short_config?: object | null;
}

const COMPLETE_SHORT_CONFIG = {
  config_version: 1,
  doodle_frames: [
    { id: "frame-00", url: "https://example.com/scene-00.png", caption_chunk_start_index: 0 },
    { id: "frame-01", url: "https://example.com/scene-01.png", caption_chunk_start_index: 1 },
  ],
  captions: [],
  voiceover_url: "https://example.com/voice.mp3",
};

async function reset(): Promise<void> {
  await run("DELETE FROM polls WHERE story_id = ?", [STORY_ID]);
  await run("DELETE FROM short_renders WHERE story_id = ?", [STORY_ID]);
  await run("DELETE FROM stories WHERE id = ?", [STORY_ID]);
}

async function seedComplete(overrides: SeedOverrides = {}): Promise<void> {
  const now = new Date().toISOString();
  const body = overrides.body === null ? null : overrides.body ?? "Body text long enough to publish.";
  const hero = overrides.hero_image === null ? null : overrides.hero_image ?? "https://example.com/hero.png";
  const heroLand =
    overrides.hero_image_landscape === null
      ? null
      : overrides.hero_image_landscape ?? "https://example.com/hero-landscape.png";
  const thumb =
    overrides.thumbnail_image === null
      ? null
      : overrides.thumbnail_image ?? "https://example.com/thumb.png";
  const thumbLand =
    overrides.thumbnail_image_landscape === null
      ? null
      : overrides.thumbnail_image_landscape ?? "https://example.com/thumb-landscape.png";
  const thumbSq =
    overrides.thumbnail_image_square === null
      ? null
      : overrides.thumbnail_image_square ?? "https://example.com/thumb-square.png";
  const status = overrides.status ?? "review";
  const shortConfig =
    overrides.short_config === null
      ? null
      : JSON.stringify(overrides.short_config ?? COMPLETE_SHORT_CONFIG);

  await run(
    `INSERT INTO stories
       (id, category, title, status, body, hero_image,
        hero_image_landscape, thumbnail_image, thumbnail_image_landscape,
        thumbnail_image_square, short_config, created_at, updated_at)
     VALUES (?, 'Drama', 'T', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [STORY_ID, status, body, hero, heroLand, thumb, thumbLand, thumbSq, shortConfig, now, now],
  );

  // short_render row representing a completed assembly — what the
  // gate looks for via latestDoneShortRenderForStory.
  await run(
    `INSERT INTO short_renders
       (id, story_id, status, output_url, props, requested_at)
     VALUES (?, ?, 'done', ?, ?, ?)`,
    [RENDER_ID, STORY_ID, "https://example.com/short.mp4", "{}", now],
  );

  // Poll attached + enabled + question filled.
  await run(
    `INSERT INTO polls
       (id, story_id, article_id, question, option_a_text, option_b_text,
        enabled, category, created_at, updated_at)
     VALUES (?, ?, NULL, 'Who is right?', 'A', 'B', 1, 'Drama', ?, ?)`,
    [POLL_ID, STORY_ID, now, now],
  );
}

beforeEach(async () => {
  await reset();
});

afterEach(async () => {
  await reset();
});

describe("evaluateAssetCompleteness", () => {
  it("returns ready=true when every gate passes", async () => {
    await seedComplete();
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.missing).toEqual([]);
    expect(r.ready).toBe(true);
    expect(r.details.body_present).toBe(true);
    expect(r.details.hero_image_present).toBe(true);
    expect(r.details.short_render_present).toBe(true);
    expect(r.details.voiceover_present).toBe(true);
    expect(r.details.poll_present_and_enabled).toBe(true);
    expect(r.details.scenes_with_url).toBe(r.details.scenes_total);
  });

  it("flags story_missing when the row doesn't exist", async () => {
    const r = await evaluateAssetCompleteness("nope-no-such-story");
    expect(r.ready).toBe(false);
    expect(r.missing).toContain("story_missing");
  });

  it("flags body when story body is empty", async () => {
    await seedComplete({ body: "" });
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.missing).toContain("body");
    expect(r.ready).toBe(false);
  });

  it("flags hero_image when hero is missing", async () => {
    await seedComplete({ hero_image: null });
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.missing).toContain("hero_image");
  });

  it("flags each per-platform thumbnail variant independently", async () => {
    await seedComplete({
      hero_image_landscape: null,
      thumbnail_image: null,
      thumbnail_image_landscape: null,
      thumbnail_image_square: null,
    });
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.missing).toContain("hero_image_landscape");
    expect(r.missing).toContain("thumbnail_image");
    expect(r.missing).toContain("thumbnail_image_landscape");
    expect(r.missing).toContain("thumbnail_image_square");
  });

  it("flags short_render when no completed short exists", async () => {
    await seedComplete();
    await run("UPDATE short_renders SET status = 'rendering' WHERE story_id = ?", [STORY_ID]);
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.missing).toContain("short_render");
  });

  it("does NOT flag voiceover when short_render is done, even if short_config has no voiceover_url", async () => {
    // A completed short_renders row is the proof that voiceover
    // existed at render time. Legacy stories whose short_config was
    // never seeded by the editor have voiceover_url=null even though
    // their short rendered successfully — gating on the editor blob
    // would falsely block publishing them.
    await seedComplete({
      short_config: {
        config_version: 1,
        doodle_frames: COMPLETE_SHORT_CONFIG.doodle_frames,
        captions: [],
      },
    });
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.missing).not.toContain("voiceover");
    expect(r.missing).not.toContain("scene_images");
    expect(r.ready).toBe(true);
  });

  it("does NOT flag scene_images when short_render is done, even if a frame url is empty", async () => {
    await seedComplete({
      short_config: {
        config_version: 1,
        doodle_frames: [
          { id: "frame-00", url: "https://example.com/scene-00.png", caption_chunk_start_index: 0 },
          { id: "frame-01", url: "", caption_chunk_start_index: 1 },
        ],
        captions: [],
        voiceover_url: COMPLETE_SHORT_CONFIG.voiceover_url,
      },
    });
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.missing).not.toContain("scene_images");
    expect(r.ready).toBe(true);
  });

  it("DOES surface voiceover + scene_images as hints when short_render is missing entirely", async () => {
    // Without a successful short_render, the gate falls back to
    // walking short_config so the operator's log shows which sub-
    // asset to re-enqueue.
    await seedComplete({
      short_config: {
        config_version: 1,
        doodle_frames: [],
        captions: [],
      },
    });
    await run("UPDATE short_renders SET status = 'rendering' WHERE story_id = ?", [STORY_ID]);
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.missing).toContain("short_render");
    expect(r.missing).toContain("voiceover");
    expect(r.missing).toContain("scene_images");
  });

  it("flags poll when no poll row exists for the story", async () => {
    await seedComplete();
    await run("DELETE FROM polls WHERE story_id = ?", [STORY_ID]);
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.missing).toContain("poll");
  });

  it("flags poll when the poll exists but is disabled", async () => {
    await seedComplete();
    await run("UPDATE polls SET enabled = 0 WHERE story_id = ?", [STORY_ID]);
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.missing).toContain("poll");
  });

  it("flags already_published for stories whose status is already published", async () => {
    await seedComplete({ status: "published" });
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.missing).toContain("already_published");
    expect(r.ready).toBe(false);
  });

  it("ignores a null short_config when short_render is done (trusts the render)", async () => {
    await seedComplete({ short_config: null });
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.missing).not.toContain("voiceover");
    expect(r.missing).not.toContain("scene_images");
    expect(r.ready).toBe(true);
  });

  it("falls back to short_config when short_render is missing AND short_config is null", async () => {
    await seedComplete({ short_config: null });
    await run("DELETE FROM short_renders WHERE story_id = ?", [STORY_ID]);
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.missing).toContain("short_render");
    expect(r.missing).toContain("voiceover");
    expect(r.missing).toContain("scene_images");
  });
});
