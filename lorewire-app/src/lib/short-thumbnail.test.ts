// Tests for short-thumbnail.ts — the per-story cover-image resolver
// shared by all four social publishers.
//
// _plans/2026-06-28-explicit-thumbnail-uploads.md.

import { describe, expect, it, beforeEach } from "vitest";
import { run } from "@/lib/db";
import { resolveShortThumbnailUrl } from "@/lib/short-thumbnail";

async function seedStory(
  id: string,
  shortConfig: Record<string, unknown> | null,
): Promise<void> {
  await run(`DELETE FROM stories WHERE id = ?`, [id]);
  await run(
    `INSERT INTO stories (id, title, body, summary, status, short_config)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      "Title",
      "Body",
      "Summary",
      "published",
      shortConfig === null ? null : JSON.stringify(shortConfig),
    ],
  );
}

describe("resolveShortThumbnailUrl", () => {
  beforeEach(async () => {
    await run(`DELETE FROM stories WHERE id LIKE 'st-thumb-%'`, []);
  });

  it("returns the scene-1 url from a well-formed short_config", async () => {
    await seedStory("st-thumb-1", {
      duration_ms: 50000,
      doodle_frames: [
        { id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" },
        { id: "frame-01", url: "https://media.lorewire.com/x/frame-01.png" },
      ],
      captions: [],
    });
    const url = await resolveShortThumbnailUrl("st-thumb-1");
    expect(url).toBe("https://media.lorewire.com/x/frame-00.png");
  });

  it("returns null when the story has no short_config", async () => {
    await seedStory("st-thumb-2", null);
    expect(await resolveShortThumbnailUrl("st-thumb-2")).toBeNull();
  });

  it("returns null when short_config is malformed JSON", async () => {
    // Bypass the JSON.stringify helper to plant raw garbage.
    await run(`DELETE FROM stories WHERE id = ?`, ["st-thumb-3"]);
    await run(
      `INSERT INTO stories (id, title, body, summary, status, short_config)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["st-thumb-3", "t", "b", "s", "published", "{not json"],
    );
    expect(await resolveShortThumbnailUrl("st-thumb-3")).toBeNull();
  });

  it("returns null when short_config parses but has no doodle_frames", async () => {
    await seedStory("st-thumb-4", {
      duration_ms: 50000,
      // doodle_frames intentionally missing
      captions: [],
    });
    expect(await resolveShortThumbnailUrl("st-thumb-4")).toBeNull();
  });

  it("returns null when doodle_frames is empty", async () => {
    await seedStory("st-thumb-5", {
      duration_ms: 50000,
      doodle_frames: [],
      captions: [],
    });
    expect(await resolveShortThumbnailUrl("st-thumb-5")).toBeNull();
  });

  it("returns null when the story id doesn't exist", async () => {
    expect(
      await resolveShortThumbnailUrl("st-thumb-nonexistent"),
    ).toBeNull();
  });

  it("returns null on empty story id input", async () => {
    expect(await resolveShortThumbnailUrl("")).toBeNull();
  });
});
