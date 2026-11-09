// Tests for the short-video cache-bust (2026-07-03). The renderer
// overwrites the SAME R2 object key per story with a one-year immutable
// Cache-Control, so a byte-identical URL kept playing the OLD MP4 after
// a restart (observed on 1pu6a9n: new render done for hours, old video
// still served). Three layers are pinned here:
//   1. bustShortVideoUrl — the URL stamper (idempotent).
//   2. finishShortRender — the completion write stores a busted URL.
//   3. bustShortVideoUrls — the boot self-heal for pre-fix rows.

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { one, run, bustShortVideoUrls } from "@/lib/db";
import { finishShortRender } from "@/lib/short-render-queue";
import {
  SHORT_VIDEO_PATH_RE,
  bustShortVideoUrl,
} from "@/lib/short-video-url";

const PLAIN = "https://media.lorewire.com/abc-short/video.mp4";

describe("bustShortVideoUrl", () => {
  it("appends ?v=<epoch> and the result still matches the short matcher", () => {
    const busted = bustShortVideoUrl(PLAIN);
    expect(busted).toMatch(/-short\/video\.mp4\?v=\d+$/);
    expect(SHORT_VIDEO_PATH_RE.test(busted)).toBe(true);
  });

  it("is idempotent on an already-busted URL", () => {
    const busted = bustShortVideoUrl(PLAIN);
    expect(bustShortVideoUrl(busted)).toBe(busted);
  });

  it("uses & when the URL already carries a query", () => {
    expect(bustShortVideoUrl(`${PLAIN}?sig=x`)).toMatch(/\?sig=x&v=\d+$/);
  });
});

describe("finishShortRender", () => {
  it("stores a cache-busted output_url", async () => {
    const id = randomUUID();
    const storyId = randomUUID();
    await run(
      "INSERT INTO short_renders (id, story_id, config_hash, status, progress, requested_at) " +
        "VALUES (?, ?, ?, 'rendering', 0.5, ?)",
      [id, storyId, `hash-${id.slice(0, 8)}`, new Date().toISOString()],
    );
    await finishShortRender(id, `https://media.lorewire.com/${storyId}-short/video.mp4`);
    const row = await one<{ status: string; output_url: string }>(
      "SELECT status, output_url FROM short_renders WHERE id = ?",
      [id],
    );
    expect(row?.status).toBe("done");
    expect(row?.output_url).toMatch(/-short\/video\.mp4\?v=\d+$/);
  });
});

describe("bustShortVideoUrls (boot self-heal)", () => {
  it("stamps plain URLs once and never double-stamps", async () => {
    const storyId = randomUUID();
    const renderId = randomUUID();
    await run(
      "INSERT INTO stories (id, slug, title, status, video_url, created_at, updated_at) " +
        "VALUES (?, ?, 'Bust fixture', 'published', ?, ?, ?)",
      [
        storyId,
        `bust-${storyId.slice(0, 6)}`,
        `https://media.lorewire.com/${storyId}-short/video.mp4`,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    await run(
      "INSERT INTO short_renders (id, story_id, config_hash, status, progress, requested_at, output_url) " +
        "VALUES (?, ?, ?, 'done', 1, ?, ?)",
      [
        renderId,
        storyId,
        `hash-${renderId.slice(0, 8)}`,
        new Date().toISOString(),
        `https://media.lorewire.com/${storyId}-short/video.mp4`,
      ],
    );

    await bustShortVideoUrls();
    const story = await one<{ video_url: string }>(
      "SELECT video_url FROM stories WHERE id = ?",
      [storyId],
    );
    const render = await one<{ output_url: string }>(
      "SELECT output_url FROM short_renders WHERE id = ?",
      [renderId],
    );
    expect(story?.video_url).toMatch(/\?v=\d+$/);
    expect(render?.output_url).toMatch(/\?v=\d+$/);

    // Second run: the suffix-anchored LIKE no longer matches, so the
    // URLs stay exactly as stamped (no ?v=...?v=... pileup).
    await bustShortVideoUrls();
    const storyAfter = await one<{ video_url: string }>(
      "SELECT video_url FROM stories WHERE id = ?",
      [storyId],
    );
    expect(storyAfter?.video_url).toBe(story?.video_url);
  });
});
