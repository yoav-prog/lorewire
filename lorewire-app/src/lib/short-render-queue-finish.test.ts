// Tests for the finishShortRender + mergeAssembledDurationIntoProps
// extensions from _plans/2026-06-29-actual-mp4-duration.md.
//
// Cloud Run's ffprobe of the spliced MP4 produces the real
// assembled duration; finishShortRender merges it onto
// short_renders.props as `assembled_duration_ms` so every reader
// (homepage badge, applyShortToStory, backfill) can prefer that
// over the legacy body+intro+outro sum.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { one, run } from "@/lib/db";
import {
  finishShortRender,
  mergeAssembledDurationIntoProps,
} from "@/lib/short-render-queue";

async function reset(): Promise<void> {
  await run("DELETE FROM short_render_events WHERE 1=1", []);
  await run("DELETE FROM short_renders WHERE 1=1", []);
}

async function seedRendering(opts: {
  id: string;
  storyId: string;
  props?: string | null;
}): Promise<void> {
  await run(
    "INSERT INTO short_renders " +
      "(id, story_id, config_hash, status, progress, props, requested_at, started_at) " +
      "VALUES (?, ?, ?, 'rendering', 0.5, ?, '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:01.000Z')",
    [opts.id, opts.storyId, `cfg-${opts.id}`, opts.props ?? null],
  );
}

interface ReadRow {
  status: string;
  output_url: string | null;
  props: string | null;
  finished_at: string | null;
}

async function readRow(id: string): Promise<ReadRow | null> {
  return one<ReadRow>(
    "SELECT status, output_url, props, finished_at FROM short_renders WHERE id = ?",
    [id],
  );
}

beforeEach(async () => {
  await reset();
});

afterEach(async () => {
  await reset();
});

describe("mergeAssembledDurationIntoProps", () => {
  it("adds assembled_duration_ms onto an existing props blob without disturbing other fields", () => {
    const merged = mergeAssembledDurationIntoProps(
      JSON.stringify({ duration_ms: 35_000, voiceover_url: "x.mp3" }),
      44_000,
    );
    const parsed = JSON.parse(merged) as Record<string, unknown>;
    expect(parsed.assembled_duration_ms).toBe(44_000);
    expect(parsed.duration_ms).toBe(35_000);
    expect(parsed.voiceover_url).toBe("x.mp3");
  });

  it("overwrites a stale assembled_duration_ms with the new probed value", () => {
    const merged = mergeAssembledDurationIntoProps(
      JSON.stringify({ duration_ms: 35_000, assembled_duration_ms: 999 }),
      44_000,
    );
    const parsed = JSON.parse(merged) as Record<string, unknown>;
    expect(parsed.assembled_duration_ms).toBe(44_000);
  });

  it("returns a fresh { assembled_duration_ms } object when input props is null", () => {
    const merged = mergeAssembledDurationIntoProps(null, 44_000);
    const parsed = JSON.parse(merged) as Record<string, unknown>;
    expect(parsed).toEqual({ assembled_duration_ms: 44_000 });
  });

  it("returns a fresh object when input props is unparseable JSON", () => {
    // Better to record the measured duration than to drop it because
    // the existing row was corrupt. Matches the defensive contract.
    const merged = mergeAssembledDurationIntoProps("{not json", 44_000);
    const parsed = JSON.parse(merged) as Record<string, unknown>;
    expect(parsed).toEqual({ assembled_duration_ms: 44_000 });
  });

  it("returns a fresh object when input props is a JSON non-object (array / scalar)", () => {
    expect(JSON.parse(mergeAssembledDurationIntoProps("[1,2,3]", 5)))
      .toEqual({ assembled_duration_ms: 5 });
    expect(JSON.parse(mergeAssembledDurationIntoProps("42", 5)))
      .toEqual({ assembled_duration_ms: 5 });
  });
});

describe("finishShortRender duration merge", () => {
  it("flips status to done and merges assembled_duration_ms onto props", async () => {
    await seedRendering({
      id: "r-1",
      storyId: "s-1",
      props: JSON.stringify({ duration_ms: 35_000, voiceover_url: "x.mp3" }),
    });
    await finishShortRender("r-1", "https://gcs/bucket/short.mp4", 44_000);
    const row = await readRow("r-1");
    expect(row?.status).toBe("done");
    expect(row?.output_url).toBe("https://gcs/bucket/short.mp4");
    expect(row?.finished_at).not.toBeNull();
    const parsed = JSON.parse(row?.props ?? "{}") as Record<string, unknown>;
    expect(parsed.assembled_duration_ms).toBe(44_000);
    // body duration must not be overwritten — the planner / re-render
    // flows still read it to size the next composition.
    expect(parsed.duration_ms).toBe(35_000);
    expect(parsed.voiceover_url).toBe("x.mp3");
  });

  it("rounds a fractional assembled duration to the nearest integer ms", async () => {
    await seedRendering({
      id: "r-2",
      storyId: "s-2",
      props: JSON.stringify({ duration_ms: 35_000 }),
    });
    await finishShortRender("r-2", "https://gcs/bucket/short.mp4", 44_321.7);
    const row = await readRow("r-2");
    const parsed = JSON.parse(row?.props ?? "{}") as Record<string, unknown>;
    expect(parsed.assembled_duration_ms).toBe(44_322);
  });

  it("skips the props write when assembledDurationMs is null (legacy / probe failed)", async () => {
    // An older Cloud Run revision returns no duration_ms in its
    // response; the dispatcher forwards null and finishShortRender
    // must NOT touch props (preserving the body-only data the
    // planner depends on).
    const originalProps = JSON.stringify({ duration_ms: 35_000 });
    await seedRendering({ id: "r-3", storyId: "s-3", props: originalProps });
    await finishShortRender("r-3", "https://gcs/bucket/short.mp4", null);
    const row = await readRow("r-3");
    expect(row?.status).toBe("done");
    expect(row?.props).toBe(originalProps);
  });

  it("skips the props write when assembledDurationMs is zero or negative", async () => {
    // Defensive: a non-positive value would format as 0:00 — drop it
    // and fall through to the legacy body+intro+outro sum at read
    // time. Same contract as the 'null' case.
    for (const bad of [0, -1, Number.NaN]) {
      const originalProps = JSON.stringify({ duration_ms: 35_000 });
      const renderId = `r-bad-${bad}`;
      await seedRendering({
        id: renderId,
        storyId: `s-bad-${bad}`,
        props: originalProps,
      });
      await finishShortRender(renderId, "https://gcs/bucket/short.mp4", bad);
      const row = await readRow(renderId);
      expect(row?.props, `bad=${bad}`).toBe(originalProps);
    }
  });

  it("creates a fresh props object when the row had NULL props (defensive against malformed queue rows)", async () => {
    await seedRendering({ id: "r-4", storyId: "s-4", props: null });
    await finishShortRender("r-4", "https://gcs/bucket/short.mp4", 44_000);
    const row = await readRow("r-4");
    const parsed = JSON.parse(row?.props ?? "{}") as Record<string, unknown>;
    expect(parsed).toEqual({ assembled_duration_ms: 44_000 });
  });
});
