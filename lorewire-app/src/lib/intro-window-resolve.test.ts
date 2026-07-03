// Regression coverage for the Skip Intro window resolver
// (lib/intro-window-resolve). The 2026-07-04 production bug this pins: the
// resolver used to read `stories.props` — which is the story-world artwork
// LIST, not the render record — found no hook fields, classified every
// hook-first short as intro-first, and put the "Skip intro" button over the
// HOOK ([0, intro duration]) instead of over the intro. The fix reads the
// story's latest done `short_renders.props`.
//
// Coverage:
//   1. Hook-first render record → window opens at hook end + tail hold,
//      never at 0 (the regression).
//   2. A short with NO render record fails closed (null), because assuming
//      intro-first would recreate the bug.
//   3. A legacy render record without hook fields IS intro-first → [0, dur].
//   4. An explicit persisted window on the render props wins verbatim.
//   5. A stamp recording "no intro spliced" → null even though a live
//      intro segment exists.
//   6. The batch resolver returns the same answers per row.
// Plan: _plans/2026-07-04-skip-intro.md.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "@/lib/db";
import {
  INTRO_FADE_MS,
  INTRO_HOOK_GAP_MS,
  INTRO_INTRO_GAP_MS,
} from "@/lib/intro-window";
import {
  resolveIntroWindowForStory,
  resolveIntroWindowsForStories,
  type IntroWindowStoryRow,
} from "@/lib/intro-window-resolve";

const NOW = "2026-06-20T00:00:00.000Z";
const INTRO_SEGMENT_ID = "seg-intro-1";
const INTRO_DURATION_MS = 4000;

async function reset(): Promise<void> {
  await run("DELETE FROM short_renders WHERE 1=1", []);
  await run("DELETE FROM video_segments WHERE 1=1", []);
}

async function seedIntroSegment(): Promise<void> {
  await run(
    "INSERT INTO video_segments " +
      "(id, kind, label, source_url, normalized_url, duration_ms, enabled, " +
      " status, error, uploaded_at, aspect, created_at, updated_at) " +
      "VALUES (?, 'intro', 'brand intro', NULL, ?, ?, 1, 'ready', NULL, ?, '9:16', ?, ?)",
    [
      INTRO_SEGMENT_ID,
      `https://gcs/${INTRO_SEGMENT_ID}.mp4`,
      INTRO_DURATION_MS,
      NOW,
      NOW,
      NOW,
    ],
  );
}

async function seedDoneRender(opts: {
  id: string;
  storyId: string;
  props: Record<string, unknown>;
}): Promise<void> {
  await run(
    "INSERT INTO short_renders (id, story_id, config_hash, status, progress, " +
      "props, requested_at, finished_at) VALUES (?, ?, ?, 'done', 1, ?, ?, ?)",
    [opts.id, opts.storyId, `cfg-${opts.id}`, JSON.stringify(opts.props), NOW, NOW],
  );
}

/** A wires-shaped story row whose short_config stamp records the spliced
 *  intro — the exact-record path every dispatcher-rendered story has. */
function shortRow(id: string): IntroWindowStoryRow {
  return {
    id,
    video_url: `https://media.example/${id}-short/video.mp4`,
    short_config: JSON.stringify({
      _last_rendered_segments: {
        intro_segment_id: INTRO_SEGMENT_ID,
        outro_segment_id: null,
      },
    }),
    intro_segment_id: null,
    outro_segment_id: null,
    skip_intro: 0,
    skip_outro: 0,
    video_config: null,
  };
}

beforeEach(async () => {
  await reset();
  await seedIntroSegment();
  // The batch resolver logs a summary line; keep runner output clean.
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

describe("resolveIntroWindowForStory", () => {
  it("REGRESSION: a hook-first render record never yields a window at 0 (that would skip the hook)", async () => {
    await seedDoneRender({
      id: "r-hook",
      storyId: "s-hook",
      props: {
        duration_ms: 40_000,
        hook_end_ms: 3000,
        hook_tail_hold_ms: 200,
        assembled_duration_ms: 50_000,
      },
    });
    const w = await resolveIntroWindowForStory(shortRow("s-hook"));
    const start = 3000 + 200;
    expect(w).toEqual({
      start_ms: start,
      end_ms:
        start +
        INTRO_FADE_MS +
        INTRO_HOOK_GAP_MS +
        INTRO_DURATION_MS +
        INTRO_INTRO_GAP_MS,
    });
    expect(w?.start_ms).toBeGreaterThan(0);
  });

  it("fails closed for a short with NO render record (can't classify the splice)", async () => {
    // No short_renders row seeded — assuming intro-first here is exactly
    // the bug this file pins.
    const w = await resolveIntroWindowForStory(shortRow("s-orphan"));
    expect(w).toBeNull();
  });

  it("classifies a legacy render record (no hook fields) as intro-first", async () => {
    await seedDoneRender({
      id: "r-legacy",
      storyId: "s-legacy",
      props: { duration_ms: 40_000, assembled_duration_ms: 44_000 },
    });
    const w = await resolveIntroWindowForStory(shortRow("s-legacy"));
    expect(w).toEqual({ start_ms: 0, end_ms: INTRO_DURATION_MS });
  });

  it("prefers an explicit persisted window over any derivation", async () => {
    await seedDoneRender({
      id: "r-explicit",
      storyId: "s-explicit",
      props: {
        duration_ms: 40_000,
        hook_end_ms: 3000,
        hook_tail_hold_ms: 200,
        intro_start_ms: 3333,
        intro_end_ms: 9999,
      },
    });
    const w = await resolveIntroWindowForStory(shortRow("s-explicit"));
    expect(w).toEqual({ start_ms: 3333, end_ms: 9999 });
  });

  it("returns null when the stamp records a body-only render, even with a live intro segment", async () => {
    await seedDoneRender({
      id: "r-bodyonly",
      storyId: "s-bodyonly",
      props: { duration_ms: 40_000, hook_end_ms: 3000, hook_tail_hold_ms: 200 },
    });
    const row: IntroWindowStoryRow = {
      ...shortRow("s-bodyonly"),
      short_config: JSON.stringify({
        _last_rendered_segments: { intro_segment_id: null, outro_segment_id: null },
      }),
    };
    expect(await resolveIntroWindowForStory(row)).toBeNull();
  });

  it("uses the LATEST done render when a story has several", async () => {
    await run(
      "INSERT INTO short_renders (id, story_id, config_hash, status, progress, " +
        "props, requested_at, finished_at) VALUES " +
        "('r-old', 's-multi', 'c1', 'done', 1, ?, '2026-06-18T00:00:00.000Z', '2026-06-18T00:00:00.000Z')," +
        "('r-new', 's-multi', 'c2', 'done', 1, ?, '2026-06-21T00:00:00.000Z', '2026-06-21T00:00:00.000Z')",
      [
        JSON.stringify({ duration_ms: 40_000 }), // old: legacy intro-first
        JSON.stringify({
          duration_ms: 40_000,
          intro_start_ms: 3200,
          intro_end_ms: 9650,
        }),
      ],
    );
    const w = await resolveIntroWindowForStory(shortRow("s-multi"));
    expect(w).toEqual({ start_ms: 3200, end_ms: 9650 });
  });
});

describe("resolveIntroWindowsForStories (wires batch)", () => {
  it("resolves each row off its own render record, failing closed for orphans", async () => {
    await seedDoneRender({
      id: "r-b1",
      storyId: "s-b1",
      props: { duration_ms: 40_000, hook_end_ms: 3000, hook_tail_hold_ms: 200 },
    });
    await seedDoneRender({
      id: "r-b2",
      storyId: "s-b2",
      props: { duration_ms: 40_000 },
    });
    const map = await resolveIntroWindowsForStories([
      shortRow("s-b1"),
      shortRow("s-b2"),
      shortRow("s-b3"), // no render record
    ]);
    expect(map.get("s-b1")?.start_ms).toBe(3200);
    expect(map.get("s-b2")).toEqual({ start_ms: 0, end_ms: INTRO_DURATION_MS });
    expect(map.get("s-b3")).toBeNull();
  });
});
