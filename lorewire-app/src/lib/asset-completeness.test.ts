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
import {
  evaluateAssetCompleteness,
  evaluateAssetCompletenessForStories,
} from "@/lib/asset-completeness";

const STORY_ID = "test-ac-story";
// Second story for the batch tests — one call, two verdicts.
const STORY_ID_B = "test-ac-story-b";

interface SeedOverrides {
  body?: string | null;
  hero_image?: string | null;
  hero_image_landscape?: string | null;
  thumbnail_image?: string | null;
  thumbnail_image_landscape?: string | null;
  thumbnail_image_square?: string | null;
  status?: string;
  short_config?: object | null;
  video_url?: string | null;
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
  for (const id of [STORY_ID, STORY_ID_B]) {
    await run("DELETE FROM polls WHERE story_id = ?", [id]);
    await run("DELETE FROM short_renders WHERE story_id = ?", [id]);
    await run("DELETE FROM stories WHERE id = ?", [id]);
  }
}

async function seedComplete(
  overrides: SeedOverrides = {},
  storyId: string = STORY_ID,
): Promise<void> {
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
  const videoUrl =
    overrides.video_url === null
      ? null
      : overrides.video_url ?? "https://example.com/short.mp4";

  await run(
    `INSERT INTO stories
       (id, category, title, status, body, hero_image,
        hero_image_landscape, thumbnail_image, thumbnail_image_landscape,
        thumbnail_image_square, short_config, video_url, created_at, updated_at)
     VALUES (?, 'Drama', 'T', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [storyId, status, body, hero, heroLand, thumb, thumbLand, thumbSq, shortConfig, videoUrl, now, now],
  );

  // short_render row representing a completed assembly — what the
  // gate looks for via latestDoneShortRenderForStory.
  await run(
    `INSERT INTO short_renders
       (id, story_id, status, output_url, props, requested_at)
     VALUES (?, ?, 'done', ?, ?, ?)`,
    [`${storyId}-render`, storyId, "https://example.com/short.mp4", "{}", now],
  );

  // Poll attached + enabled + question filled.
  await run(
    `INSERT INTO polls
       (id, story_id, article_id, question, option_a_text, option_b_text,
        enabled, category, created_at, updated_at)
     VALUES (?, ?, NULL, 'Who is right?', 'A', 'B', 1, 'Drama', ?, ?)`,
    [`${storyId}-poll`, storyId, now, now],
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
    expect(r.details.video_url_present).toBe(true);
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
    // The portrait thumbnail is load-bearing (homepage cards); the
    // landscape/square variants are advisory and must not block.
    expect(r.blocking).toContain("thumbnail_image");
    expect(r.blocking).not.toContain("hero_image_landscape");
    expect(r.blocking).not.toContain("thumbnail_image_landscape");
    expect(r.blocking).not.toContain("thumbnail_image_square");
  });

  // 2026-07-04 (1l23hhc): a single flaky kie call on the Instagram-only
  // square thumbnail was hard-blocking web publishes. Advisory gates
  // are still REPORTED (so the complete-and-publish cron backfills
  // them) but publish readiness no longer hinges on them.
  it("stays ready when only advisory variants are missing", async () => {
    await seedComplete({
      hero_image_landscape: null,
      thumbnail_image_landscape: null,
      thumbnail_image_square: null,
    });
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.ready).toBe(true);
    expect(r.blocking).toEqual([]);
    expect(r.missing).toContain("thumbnail_image_square");
  });

  it("does not publish-block on advisory gates but does on the portrait thumbnail", async () => {
    await seedComplete({ thumbnail_image: null });
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.ready).toBe(false);
    expect(r.blocking).toEqual(["thumbnail_image"]);
  });

  it("flags short_render when no completed short exists", async () => {
    await seedComplete();
    await run("UPDATE short_renders SET status = 'rendering' WHERE story_id = ?", [STORY_ID]);
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.missing).toContain("short_render");
  });

  // The 2026-07-02 incident: a done render existed in storage but the
  // copy onto stories.video_url was missed, and the gate let the story
  // publish with nothing for the public reader to play. The gate must
  // require the column itself, independent of the render row.
  // Plan: _plans/2026-07-02-never-publish-without-video.md.
  it("flags video_url when NULL even though a done short render exists", async () => {
    await seedComplete({ video_url: null });
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.details.short_render_present).toBe(true);
    expect(r.missing).toContain("video_url");
    expect(r.details.video_url_present).toBe(false);
    expect(r.ready).toBe(false);
  });

  it("flags video_url when it is an empty string", async () => {
    await seedComplete({ video_url: "" });
    const r = await evaluateAssetCompleteness(STORY_ID);
    expect(r.missing).toContain("video_url");
    expect(r.ready).toBe(false);
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

// The batch evaluator feeds the Content list's per-row "missing: …"
// chips. Its contract is verdict parity with the single-story gate —
// same deriveAssetCompleteness underneath, so these tests pin the
// input-assembly (the SQL) rather than re-testing every gate.
// Plan: _plans/2026-07-21-content-row-publish-blockers.md.
describe("evaluateAssetCompletenessForStories", () => {
  it("returns an empty map for an empty id list", async () => {
    const m = await evaluateAssetCompletenessForStories([]);
    expect(m.size).toBe(0);
  });

  it("omits ids that have no stories row", async () => {
    await seedComplete();
    const m = await evaluateAssetCompletenessForStories([
      STORY_ID,
      "nope-no-such-story",
    ]);
    expect(m.has(STORY_ID)).toBe(true);
    expect(m.has("nope-no-such-story")).toBe(false);
  });

  it("matches the single-story verdict across scenarios", async () => {
    const scenarios: { name: string; seed: () => Promise<void> }[] = [
      { name: "complete", seed: () => seedComplete() },
      {
        name: "missing portrait thumbnail",
        seed: () => seedComplete({ thumbnail_image: null }),
      },
      {
        name: "advisory variants only",
        seed: () =>
          seedComplete({
            hero_image_landscape: null,
            thumbnail_image_landscape: null,
            thumbnail_image_square: null,
          }),
      },
      {
        name: "empty body + missing hero",
        seed: () => seedComplete({ body: "", hero_image: null }),
      },
      { name: "empty video_url", seed: () => seedComplete({ video_url: "" }) },
      { name: "already published", seed: () => seedComplete({ status: "published" }) },
      {
        name: "short missing with scene hints",
        seed: async () => {
          await seedComplete({
            short_config: { config_version: 1, doodle_frames: [], captions: [] },
          });
          await run(
            "UPDATE short_renders SET status = 'rendering' WHERE story_id = ?",
            [STORY_ID],
          );
        },
      },
      {
        name: "disabled poll",
        seed: async () => {
          await seedComplete();
          await run("UPDATE polls SET enabled = 0 WHERE story_id = ?", [
            STORY_ID,
          ]);
        },
      },
    ];
    for (const scenario of scenarios) {
      await reset();
      await scenario.seed();
      const single = await evaluateAssetCompleteness(STORY_ID);
      const batch = (
        await evaluateAssetCompletenessForStories([STORY_ID])
      ).get(STORY_ID);
      expect(batch, scenario.name).toBeDefined();
      expect(
        {
          ready: batch!.ready,
          missing: batch!.missing,
          blocking: batch!.blocking,
        },
        scenario.name,
      ).toEqual({
        ready: single.ready,
        missing: single.missing,
        blocking: single.blocking,
      });
    }
  });

  it("evaluates several stories in one call", async () => {
    await seedComplete();
    await seedComplete({}, STORY_ID_B);
    await run("DELETE FROM polls WHERE story_id = ?", [STORY_ID_B]);
    const m = await evaluateAssetCompletenessForStories([STORY_ID, STORY_ID_B]);
    expect(m.get(STORY_ID)?.ready).toBe(true);
    expect(m.get(STORY_ID)?.blocking).toEqual([]);
    expect(m.get(STORY_ID_B)?.ready).toBe(false);
    expect(m.get(STORY_ID_B)?.blocking).toEqual(["poll"]);
  });

  it("judges the LATEST done render, matching the single path", async () => {
    // A newer done-with-props render without an output_url must win over
    // the older complete one — the semantics latestDoneShortRenderForStory
    // gives the single path.
    await seedComplete();
    const later = new Date(Date.now() + 60_000).toISOString();
    await run(
      `INSERT INTO short_renders
         (id, story_id, status, output_url, props, requested_at)
       VALUES (?, ?, 'done', NULL, '{}', ?)`,
      [`${STORY_ID}-render-newer`, STORY_ID, later],
    );
    const single = await evaluateAssetCompleteness(STORY_ID);
    const batch = (
      await evaluateAssetCompletenessForStories([STORY_ID])
    ).get(STORY_ID);
    expect(single.missing).toContain("short_render");
    expect(batch?.missing).toEqual(single.missing);
    expect(batch?.blocking).toEqual(single.blocking);
  });
});
