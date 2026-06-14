// Cleavage-line test for the 2026-06-14 pipeline_cache column.
//
// The bug this guards against: pipeline-owned data (world_bible,
// scene_prompts, scene_prompts_built_with, scene_entity_ids,
// character_bible) used to live inside stories.video_config — the same
// JSON column the video editor owns. The editor's parseVideoConfig
// strictly drops unknown top-level fields, so every heartbeat write
// silently wiped the pipeline cache and forced the first scene worker
// in every Rebuild batch to re-pay the ~$0.30 world-bible build cost.
// The cron's 270s deadline killed the function before the second scene
// completed; the reaper reset the row; next tick re-claimed and
// re-burned. See _plans/2026-06-14-pipeline-cache-column.md.
//
// The fix moves the five fields into stories.pipeline_cache, which the
// editor never reads or writes. This test asserts that contract from
// the TS side: a representative editor-save round-trip
// (`setStoryConfigJson` with a parseVideoConfig'd value) MUST leave
// pipeline_cache untouched on every save path the editor uses today
// (manual patch, edit-session claim, heartbeat).

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { one, run } from "@/lib/db";
import { setStoryConfigJson } from "@/lib/repo";
import {
  applyConfigPatch,
  defaultVideoConfig,
  parseVideoConfig,
  type ShortVideoConfig,
} from "@/lib/video-config";

const STARTING_CACHE = {
  world_bible: {
    built_with: "world_bible_v1",
    characters: [
      { id: "ab12", name: "Alice", role: "lead", visual_cues: "red hat" },
    ],
    sub_characters: [],
    locations: [
      { id: "cd34", name: "office", visual_cues: "open-plan, blue carpet" },
    ],
    items: [],
  },
  scene_prompts: ["alice at desk", "alice and the envelope", "alice leaves"],
  scene_prompts_built_with: "world_bible_v1",
  scene_entity_ids: [["ab12"], ["ab12"], ["ab12", "cd34"]],
  character_bible: {
    characters: [{ name: "Alice", visual_cues: "red hat" }],
    summary: "office story",
  },
};

const STARTING_VIDEO_CONFIG = {
  voiceover_url: "https://example.com/vo.mp3",
  duration_ms: 30000,
  doodle_frames: [
    {
      id: "f-0",
      url: "https://example.com/s0.png",
      caption_chunk_start_index: 0,
    },
  ],
  captions: [],
  title: "office story",
  channel_name: "lorewire",
};

beforeAll(async () => {
  // Force the lazy schema migration so the stories table + the new
  // pipeline_cache column exist before the first INSERT below.
  await one("SELECT 1", []);
});

beforeEach(async () => {
  await run("DELETE FROM stories", []);
});

async function seedStory(): Promise<{ storyId: string }> {
  const storyId = randomUUID();
  await run(
    "INSERT INTO stories (id, video_config, pipeline_cache) VALUES (?, ?, ?)",
    [
      storyId,
      JSON.stringify(STARTING_VIDEO_CONFIG),
      JSON.stringify(STARTING_CACHE),
    ],
  );
  return { storyId };
}

async function readBoth(storyId: string): Promise<{
  video_config: unknown;
  pipeline_cache: unknown;
}> {
  const row = await one<{
    video_config: string | null;
    pipeline_cache: string | null;
  }>(
    "SELECT video_config, pipeline_cache FROM stories WHERE id = ?",
    [storyId],
  );
  return {
    video_config: row?.video_config ? JSON.parse(row.video_config) : null,
    pipeline_cache: row?.pipeline_cache ? JSON.parse(row.pipeline_cache) : null,
  };
}

describe("pipeline_cache survives editor saves (2026-06-14 cleavage)", () => {
  it("manual patch save (saveVideoConfigPatch shape) preserves pipeline_cache verbatim", async () => {
    const { storyId } = await seedStory();
    const before = await readBoth(storyId);
    expect(before.pipeline_cache).toEqual(STARTING_CACHE);

    // Mirror the lib-level transform saveVideoConfigPatch runs after
    // requireAdmin: parse the base, apply a patch, re-parse, persist.
    const baseResult = parseVideoConfig(before.video_config);
    expect(baseResult.ok).toBe(true);
    const base = (baseResult as { ok: true; config: ShortVideoConfig }).config;
    const patched = applyConfigPatch(
      base,
      { duration_ms: 35000 },
      ["duration_ms"],
    );
    const validated = parseVideoConfig(patched);
    expect(validated.ok).toBe(true);
    await setStoryConfigJson(
      storyId,
      JSON.stringify((validated as { ok: true; config: ShortVideoConfig }).config),
    );

    const after = await readBoth(storyId);
    // pipeline_cache MUST be byte-for-byte unchanged.
    expect(after.pipeline_cache).toEqual(STARTING_CACHE);
    // sanity: the editor's video_config did update.
    expect((after.video_config as { duration_ms: number }).duration_ms).toBe(
      35000,
    );
  });

  it("edit-session claim (claimEditSession shape) preserves pipeline_cache", async () => {
    const { storyId } = await seedStory();

    // Mirror claimEditSession: read story, run through parseVideoConfig
    // (drops unknown fields), append _edit_session, persist.
    const before = await readBoth(storyId);
    const baseResult = parseVideoConfig(before.video_config);
    expect(baseResult.ok).toBe(true);
    const base =
      (baseResult as { ok: true; config: ShortVideoConfig }).config ??
      defaultVideoConfig({ id: storyId } as never);
    const next: ShortVideoConfig = {
      ...base,
      _edit_session: {
        user_id: "test-user",
        started_at: "2026-06-14T05:00:00.000Z",
        heartbeat_at: "2026-06-14T05:00:00.000Z",
      },
    };
    await setStoryConfigJson(storyId, JSON.stringify(next));

    const after = await readBoth(storyId);
    expect(after.pipeline_cache).toEqual(STARTING_CACHE);
  });

  it("edit-session heartbeat (heartbeatEditSession shape) preserves pipeline_cache", async () => {
    const { storyId } = await seedStory();

    // Mirror the heartbeat path: same parseVideoConfig round-trip but
    // only bumps heartbeat_at. This was the bug's most frequent trigger
    // because the heartbeat fires while the editor tab is open without
    // any user action.
    const before = await readBoth(storyId);
    const baseResult = parseVideoConfig(before.video_config);
    const base = (baseResult as { ok: true; config: ShortVideoConfig }).config;
    const next: ShortVideoConfig = {
      ...base,
      _edit_session: {
        user_id: "test-user",
        started_at: "2026-06-14T05:00:00.000Z",
        heartbeat_at: "2026-06-14T05:05:00.000Z",
      },
    };
    await setStoryConfigJson(storyId, JSON.stringify(next));

    const after = await readBoth(storyId);
    expect(after.pipeline_cache).toEqual(STARTING_CACHE);
  });

  it("a story with the legacy shape (cache fields inside video_config) is parsed as if those fields are absent", async () => {
    // Defends against the pre-migration shape. parseVideoConfig should
    // still drop the unknown top-level fields the way it always has;
    // the data in video_config isn't accessible to the editor and
    // doesn't bleed into the typed config.
    const storyId = randomUUID();
    const legacyConfig = { ...STARTING_VIDEO_CONFIG, ...STARTING_CACHE };
    await run(
      "INSERT INTO stories (id, video_config, pipeline_cache) VALUES (?, ?, NULL)",
      [storyId, JSON.stringify(legacyConfig)],
    );
    const row = await one<{ video_config: string }>(
      "SELECT video_config FROM stories WHERE id = ?",
      [storyId],
    );
    const result = parseVideoConfig(JSON.parse(row!.video_config));
    expect(result.ok).toBe(true);
    const config =
      (result as { ok: true; config: ShortVideoConfig }).config as Record<
        string,
        unknown
      >;
    // parseVideoConfig drops every cache field — same behavior that
    // caused the bug. After the migration moves these to pipeline_cache,
    // the editor still won't see them, which is the desired contract.
    expect("world_bible" in config).toBe(false);
    expect("scene_prompts" in config).toBe(false);
    expect("scene_prompts_built_with" in config).toBe(false);
    expect("scene_entity_ids" in config).toBe(false);
    expect("character_bible" in config).toBe(false);
  });
});
