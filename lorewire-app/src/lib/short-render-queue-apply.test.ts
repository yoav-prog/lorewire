// applyShortToStory writes both stories.video_url and stories.duration.
// The duration write is what keeps the public rail thumbnail badge in sync
// with the actual short length — without it the badge falls through to the
// legacy "2:00" long-form default for every auto-applied short.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { all, one, run } from "@/lib/db";
import { applyShortToStory } from "@/lib/short-render-queue";

async function reset(): Promise<void> {
  await run("DELETE FROM short_renders WHERE 1=1", []);
  await run("DELETE FROM stories WHERE 1=1", []);
  await run("DELETE FROM video_segments WHERE 1=1", []);
}

async function seedStory(
  id: string,
  opts: {
    duration?: string | null;
    /** Stamp `_last_rendered_segments` onto stories.short_config so
     *  applyShortToStory's full-duration computation can pick up the
     *  spliced intro/outro alongside the body. */
    lastRenderedSegments?: {
      intro_segment_id: string | null;
      outro_segment_id: string | null;
    };
  } = {},
): Promise<void> {
  const shortConfig = opts.lastRenderedSegments
    ? JSON.stringify({ _last_rendered_segments: opts.lastRenderedSegments })
    : null;
  await run(
    "INSERT INTO stories (id, slug, title, category, summary, status, duration, " +
      "short_config, created_at, published_at) " +
      "VALUES (?, ?, ?, 'Drama', 'syn', 'published', ?, ?, ?, ?)",
    [
      id,
      `slug-${id}`,
      `Title ${id}`,
      opts.duration ?? null,
      shortConfig,
      "2026-06-20T00:00:00.000Z",
      "2026-06-20T00:00:00.000Z",
    ],
  );
}

const SEG_NOW = "2026-06-20T00:00:00.000Z";

async function seedSegment(opts: {
  id: string;
  kind: "intro" | "outro";
  durationMs: number;
}): Promise<void> {
  await run(
    "INSERT INTO video_segments " +
      "(id, kind, label, source_url, normalized_url, duration_ms, enabled, " +
      " status, error, uploaded_at, aspect, created_at, updated_at) " +
      "VALUES (?, ?, ?, NULL, ?, ?, 1, 'ready', NULL, ?, '9:16', ?, ?)",
    [
      opts.id,
      opts.kind,
      `seg-${opts.id}`,
      `https://gcs/${opts.id}.mp4`,
      opts.durationMs,
      SEG_NOW,
      SEG_NOW,
      SEG_NOW,
    ],
  );
}

interface StoryRow {
  id: string;
  video_url: string | null;
  duration: string | null;
}

beforeEach(async () => {
  await reset();
});

afterEach(async () => {
  await reset();
});

describe("applyShortToStory", () => {
  it("writes both video_url and a formatted M:SS duration from props", async () => {
    await seedStory("s-1");
    await applyShortToStory(
      "s-1",
      "https://gcs/bucket/short.mp4",
      JSON.stringify({ duration_ms: 47_000 }),
    );
    const row = await one<StoryRow>(
      "SELECT id, video_url, duration FROM stories WHERE id = ?",
      ["s-1"],
    );
    expect(row?.video_url).toBe("https://gcs/bucket/short.mp4");
    expect(row?.duration).toBe("0:47");
  });

  it("overwrites an existing duration so a re-render with new length updates the badge", async () => {
    // A previous render landed 0:28 onto stories.duration. The next render
    // produces a 1:12 short; the row must update so the rail thumbnail
    // matches whatever currently plays at video_url.
    await seedStory("s-2", { duration: "0:28" });
    await applyShortToStory(
      "s-2",
      "https://gcs/bucket/short-v2.mp4",
      JSON.stringify({ duration_ms: 72_000 }),
    );
    const row = await one<StoryRow>(
      "SELECT id, video_url, duration FROM stories WHERE id = ?",
      ["s-2"],
    );
    expect(row?.video_url).toBe("https://gcs/bucket/short-v2.mp4");
    expect(row?.duration).toBe("1:12");
  });

  it("leaves duration alone when propsJson is null", async () => {
    // Caller signals "I don't have a render row to read from"; we still
    // perform the video_url swap but the existing duration is preserved.
    await seedStory("s-3", { duration: "0:35" });
    await applyShortToStory("s-3", "https://gcs/bucket/short.mp4", null);
    const row = await one<StoryRow>(
      "SELECT id, video_url, duration FROM stories WHERE id = ?",
      ["s-3"],
    );
    expect(row?.video_url).toBe("https://gcs/bucket/short.mp4");
    expect(row?.duration).toBe("0:35");
  });

  it("leaves duration alone when propsJson is unparseable", async () => {
    await seedStory("s-4", { duration: "0:35" });
    await applyShortToStory("s-4", "https://gcs/bucket/short.mp4", "{not json}");
    const row = await one<StoryRow>(
      "SELECT id, video_url, duration FROM stories WHERE id = ?",
      ["s-4"],
    );
    expect(row?.duration).toBe("0:35");
  });

  it("leaves duration alone when duration_ms is missing or zero", async () => {
    await seedStory("s-5", { duration: "0:35" });
    await applyShortToStory(
      "s-5",
      "https://gcs/bucket/short.mp4",
      JSON.stringify({ duration_ms: 0 }),
    );
    const row = await one<StoryRow>(
      "SELECT id, video_url, duration FROM stories WHERE id = ?",
      ["s-5"],
    );
    expect(row?.duration).toBe("0:35");

    await applyShortToStory(
      "s-5",
      "https://gcs/bucket/short.mp4",
      JSON.stringify({ other_field: "anything" }),
    );
    const row2 = await one<StoryRow>(
      "SELECT id, video_url, duration FROM stories WHERE id = ?",
      ["s-5"],
    );
    expect(row2?.duration).toBe("0:35");
  });

  it("rounds 59.6s to 1:00 rather than 0:60", async () => {
    await seedStory("s-6");
    await applyShortToStory(
      "s-6",
      "https://gcs/bucket/short.mp4",
      JSON.stringify({ duration_ms: 59_600 }),
    );
    const row = await one<StoryRow>(
      "SELECT id, duration FROM stories WHERE id = ?",
      ["s-6"],
    );
    expect(row?.duration).toBe("1:00");
  });

  it("bumps stories.updated_at on every call", async () => {
    await seedStory("s-7");
    const before = await one<{ updated_at: string | null }>(
      "SELECT updated_at FROM stories WHERE id = ?",
      ["s-7"],
    );
    // Tiny delay so the second timestamp can differ; ISO strings compare lexicographically.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await applyShortToStory(
      "s-7",
      "https://gcs/bucket/short.mp4",
      JSON.stringify({ duration_ms: 30_000 }),
    );
    const after = await one<{ updated_at: string | null }>(
      "SELECT updated_at FROM stories WHERE id = ?",
      ["s-7"],
    );
    expect(after?.updated_at).not.toBe(before?.updated_at);
  });
});

describe("applyShortToStory + loadLiveCatalog integration", () => {
  it("the apply-side write removes the need for the reader-side backfill", async () => {
    // End-to-end check that the writer path closes the gap. After applying
    // a short, the live catalog row reflects the real duration WITHOUT
    // loadLiveCatalog having to JOIN against short_renders.
    await seedStory("s-int");
    await applyShortToStory(
      "s-int",
      "https://gcs/bucket/short.mp4",
      JSON.stringify({ duration_ms: 51_000 }),
    );
    // Sanity: no short_renders row exists, so any "reader fills the gap"
    // logic in homepage-data can't be what populates this.
    const renderRows = await all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM short_renders WHERE story_id = ?",
      ["s-int"],
    );
    expect(Number(renderRows[0]?.count ?? 0)).toBe(0);
    const row = await one<StoryRow>(
      "SELECT id, duration FROM stories WHERE id = ?",
      ["s-int"],
    );
    expect(row?.duration).toBe("0:51");
  });
});

describe("applyShortToStory with spliced intro/outro segments", () => {
  it("writes the FULL duration (body + intro + outro) when stories.short_config carries the stamp", async () => {
    // Mirrors the production case: 42s body + 4s intro + 3s outro = 49s
    // in the assembled MP4. stories.duration must match the player.
    await seedSegment({ id: "intro-a", kind: "intro", durationMs: 4_000 });
    await seedSegment({ id: "outro-a", kind: "outro", durationMs: 3_000 });
    await seedStory("s-seg-a", {
      lastRenderedSegments: {
        intro_segment_id: "intro-a",
        outro_segment_id: "outro-a",
      },
    });
    await applyShortToStory(
      "s-seg-a",
      "https://gcs/bucket/short.mp4",
      JSON.stringify({ duration_ms: 42_000 }),
    );
    const row = await one<StoryRow>(
      "SELECT id, video_url, duration FROM stories WHERE id = ?",
      ["s-seg-a"],
    );
    expect(row?.video_url).toBe("https://gcs/bucket/short.mp4");
    expect(row?.duration).toBe("0:49");
  });

  it("falls back to body-only when stories.short_config has no stamp", async () => {
    // Legacy story: short_config is NULL (no render has ever stamped it,
    // or stamp write failed). Writer must still produce a sane duration.
    await seedStory("s-seg-b");
    await applyShortToStory(
      "s-seg-b",
      "https://gcs/bucket/short.mp4",
      JSON.stringify({ duration_ms: 38_000 }),
    );
    const row = await one<StoryRow>(
      "SELECT id, duration FROM stories WHERE id = ?",
      ["s-seg-b"],
    );
    expect(row?.duration).toBe("0:38");
  });

  it("falls back to body-only when the stamped segment row was deleted", async () => {
    // Stamp references a segment id that no longer exists in
    // video_segments — body-only beats a 0-padded undercount.
    await seedStory("s-seg-c", {
      lastRenderedSegments: {
        intro_segment_id: "intro-missing",
        outro_segment_id: "outro-missing",
      },
    });
    await applyShortToStory(
      "s-seg-c",
      "https://gcs/bucket/short.mp4",
      JSON.stringify({ duration_ms: 27_000 }),
    );
    const row = await one<StoryRow>(
      "SELECT id, duration FROM stories WHERE id = ?",
      ["s-seg-c"],
    );
    expect(row?.duration).toBe("0:27");
  });

  it("handles a one-sided stamp (skip_outro path)", async () => {
    // short_config.skip_outro=true results in outro_segment_id=null
    // alongside a real intro_segment_id. Sum only the intro.
    await seedSegment({ id: "intro-d", kind: "intro", durationMs: 5_000 });
    await seedStory("s-seg-d", {
      lastRenderedSegments: {
        intro_segment_id: "intro-d",
        outro_segment_id: null,
      },
    });
    await applyShortToStory(
      "s-seg-d",
      "https://gcs/bucket/short.mp4",
      JSON.stringify({ duration_ms: 40_000 }),
    );
    const row = await one<StoryRow>(
      "SELECT id, duration FROM stories WHERE id = ?",
      ["s-seg-d"],
    );
    expect(row?.duration).toBe("0:45");
  });
});
