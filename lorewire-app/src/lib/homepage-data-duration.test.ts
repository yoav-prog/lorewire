// loadLiveCatalog backfills stories.duration from short_renders.props.duration_ms
// when the stories row has no duration set. Covers the rail-thumbnail "2:00"
// regression: the auto-apply path that points stories.video_url at a finished
// short never writes stories.duration, so the live catalog used to fall through
// to a "2:00" UI fallback even on a 28-second short. The loader now reads the
// real duration off the short_render row and formats it as M:SS.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "@/lib/db";

vi.mock("@/lib/poll-cookie", () => ({
  readVoteToken: async () => null,
}));
vi.mock("@/lib/user-session", () => ({
  readUserSession: async () => null,
}));
vi.mock("@/lib/impersonation", () => ({
  resolveImpersonation: async () => null,
}));

async function reset(): Promise<void> {
  await run("DELETE FROM short_renders WHERE 1=1", []);
  await run("DELETE FROM stories WHERE 1=1", []);
  await run("DELETE FROM video_segments WHERE 1=1", []);
}

async function seedStory(
  id: string,
  opts: {
    duration?: string | null;
    status?: string;
    /** Stamp `_last_rendered_segments` onto stories.short_config so the
     *  duration loader can sum intro + outro segments alongside the body. */
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
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      `slug-${id}`,
      `Title ${id}`,
      "Drama",
      "synopsis",
      opts.status ?? "published",
      opts.duration ?? null,
      shortConfig,
      "2026-06-20T00:00:00.000Z",
      "2026-06-20T00:00:00.000Z",
    ],
  );
}

const SEGMENT_NOW = "2026-06-20T00:00:00.000Z";

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
      SEGMENT_NOW,
      SEGMENT_NOW,
      SEGMENT_NOW,
    ],
  );
}

async function seedShortRender(opts: {
  id: string;
  storyId: string;
  status: string;
  props: unknown;
  finishedAt?: string;
}): Promise<void> {
  await run(
    "INSERT INTO short_renders (id, story_id, config_hash, status, progress, " +
      "props, requested_at, finished_at) " +
      "VALUES (?, ?, ?, ?, 1, ?, '2026-06-20T00:00:00.000Z', ?)",
    [
      opts.id,
      opts.storyId,
      opts.id,
      opts.status,
      opts.props === null ? null : JSON.stringify(opts.props),
      opts.finishedAt ?? null,
    ],
  );
}

beforeEach(async () => {
  await reset();
});

afterEach(async () => {
  await reset();
});

describe("loadLiveCatalog duration backfill", () => {
  it("formats short_renders.props.duration_ms as M:SS for the sub-minute case", async () => {
    await seedStory("short-a");
    await seedShortRender({
      id: "render-a",
      storyId: "short-a",
      status: "done",
      props: { duration_ms: 28_400 },
      finishedAt: "2026-06-20T01:00:00.000Z",
    });
    const { loadLiveCatalog } = await import("@/lib/homepage-data");
    const result = await loadLiveCatalog();
    expect(result.ok).toBe(true);
    const story = result.stories.find((s) => s.id === "short-a");
    expect(story?.duration).toBe("0:28");
  });

  it("formats a multi-minute duration as M:SS", async () => {
    await seedStory("short-b");
    await seedShortRender({
      id: "render-b",
      storyId: "short-b",
      status: "done",
      props: { duration_ms: 75_000 },
      finishedAt: "2026-06-20T01:00:00.000Z",
    });
    const { loadLiveCatalog } = await import("@/lib/homepage-data");
    const result = await loadLiveCatalog();
    const story = result.stories.find((s) => s.id === "short-b");
    expect(story?.duration).toBe("1:15");
  });

  it("rounds 59.6s to 1:00 rather than emitting 0:60", async () => {
    await seedStory("short-c");
    await seedShortRender({
      id: "render-c",
      storyId: "short-c",
      status: "done",
      props: { duration_ms: 59_600 },
      finishedAt: "2026-06-20T01:00:00.000Z",
    });
    const { loadLiveCatalog } = await import("@/lib/homepage-data");
    const result = await loadLiveCatalog();
    const story = result.stories.find((s) => s.id === "short-c");
    expect(story?.duration).toBe("1:00");
  });

  it("prefers the admin-set stories.duration over any short_render lookup", async () => {
    // The admin-written M:SS wins — backfill only fills the gap when
    // stories.duration is NULL, so a hand-edited override is preserved.
    await seedStory("short-d", { duration: "0:42" });
    await seedShortRender({
      id: "render-d",
      storyId: "short-d",
      status: "done",
      props: { duration_ms: 28_400 },
      finishedAt: "2026-06-20T01:00:00.000Z",
    });
    const { loadLiveCatalog } = await import("@/lib/homepage-data");
    const result = await loadLiveCatalog();
    const story = result.stories.find((s) => s.id === "short-d");
    expect(story?.duration).toBe("0:42");
  });

  it("ignores short_renders whose status is not 'done'", async () => {
    // A queued / rendering / errored row carries no usable duration_ms;
    // the loader must leave stories.duration NULL so the UI hides the badge
    // instead of painting a stale or pre-render value.
    await seedStory("short-e");
    await seedShortRender({
      id: "render-e",
      storyId: "short-e",
      status: "queued",
      props: { duration_ms: 999_000 },
    });
    const { loadLiveCatalog } = await import("@/lib/homepage-data");
    const result = await loadLiveCatalog();
    const story = result.stories.find((s) => s.id === "short-e");
    expect(story?.duration ?? null).toBeNull();
  });

  it("picks the latest done render when multiple exist for the same story", async () => {
    // Re-renders stack up over time (Lane A / B / C dispatches). The most
    // recently-finished one is the truth — its duration_ms reflects what
    // currently plays at stories.video_url.
    await seedStory("short-f");
    await seedShortRender({
      id: "render-f-old",
      storyId: "short-f",
      status: "done",
      props: { duration_ms: 18_000 },
      finishedAt: "2026-06-20T01:00:00.000Z",
    });
    await seedShortRender({
      id: "render-f-new",
      storyId: "short-f",
      status: "done",
      props: { duration_ms: 47_000 },
      finishedAt: "2026-06-20T02:00:00.000Z",
    });
    const { loadLiveCatalog } = await import("@/lib/homepage-data");
    const result = await loadLiveCatalog();
    const story = result.stories.find((s) => s.id === "short-f");
    expect(story?.duration).toBe("0:47");
  });

  it("leaves duration NULL when props is missing or unparseable", async () => {
    await seedStory("short-g");
    await seedShortRender({
      id: "render-g",
      storyId: "short-g",
      status: "done",
      props: null,
      finishedAt: "2026-06-20T01:00:00.000Z",
    });
    const { loadLiveCatalog } = await import("@/lib/homepage-data");
    const result = await loadLiveCatalog();
    const story = result.stories.find((s) => s.id === "short-g");
    expect(story?.duration ?? null).toBeNull();
  });

  it("sums body + intro + outro segments when stories.short_config carries the stamp", async () => {
    // This is the rail-vs-player mismatch case from production: body is
    // 0:42 in props.duration_ms, the spliced intro adds 4s and the outro
    // adds 3s — the assembled MP4 plays for 0:49. The badge must match
    // what the user sees in the player, not the bare body length.
    await seedSegment({ id: "intro-h", kind: "intro", durationMs: 4_000 });
    await seedSegment({ id: "outro-h", kind: "outro", durationMs: 3_000 });
    await seedStory("short-h", {
      lastRenderedSegments: {
        intro_segment_id: "intro-h",
        outro_segment_id: "outro-h",
      },
    });
    await seedShortRender({
      id: "render-h",
      storyId: "short-h",
      status: "done",
      props: { duration_ms: 42_000 },
      finishedAt: "2026-06-20T01:00:00.000Z",
    });
    const { loadLiveCatalog } = await import("@/lib/homepage-data");
    const result = await loadLiveCatalog();
    const story = result.stories.find((s) => s.id === "short-h");
    expect(story?.duration).toBe("0:49");
  });

  it("falls back to body-only when stories.short_config carries no stamp", async () => {
    // Legacy row (rendered before _last_rendered_segments was a thing, or
    // the stamp write failed). The loader must not silently produce a
    // worse badge than before this change.
    await seedStory("short-i");
    await seedShortRender({
      id: "render-i",
      storyId: "short-i",
      status: "done",
      props: { duration_ms: 28_400 },
      finishedAt: "2026-06-20T01:00:00.000Z",
    });
    const { loadLiveCatalog } = await import("@/lib/homepage-data");
    const result = await loadLiveCatalog();
    const story = result.stories.find((s) => s.id === "short-i");
    expect(story?.duration).toBe("0:28");
  });

  it("falls back to body-only when the stamped segment row is missing or has no duration", async () => {
    // A segment row was deleted between render and read. The loader must
    // not skip the badge entirely — body-only is still better than blank.
    await seedStory("short-j", {
      lastRenderedSegments: {
        intro_segment_id: "intro-gone",
        outro_segment_id: "outro-gone",
      },
    });
    await seedShortRender({
      id: "render-j",
      storyId: "short-j",
      status: "done",
      props: { duration_ms: 30_000 },
      finishedAt: "2026-06-20T01:00:00.000Z",
    });
    const { loadLiveCatalog } = await import("@/lib/homepage-data");
    const result = await loadLiveCatalog();
    const story = result.stories.find((s) => s.id === "short-j");
    expect(story?.duration).toBe("0:30");
  });

  it("handles a one-sided stamp (intro only or outro only)", async () => {
    // skip_outro=true on the short_config means the route stamps a null
    // outro_segment_id. Intro still contributes, outro contributes 0.
    await seedSegment({ id: "intro-k", kind: "intro", durationMs: 5_000 });
    await seedStory("short-k", {
      lastRenderedSegments: {
        intro_segment_id: "intro-k",
        outro_segment_id: null,
      },
    });
    await seedShortRender({
      id: "render-k",
      storyId: "short-k",
      status: "done",
      props: { duration_ms: 40_000 },
      finishedAt: "2026-06-20T01:00:00.000Z",
    });
    const { loadLiveCatalog } = await import("@/lib/homepage-data");
    const result = await loadLiveCatalog();
    const story = result.stories.find((s) => s.id === "short-k");
    expect(story?.duration).toBe("0:45");
  });

  it("admin-set stories.duration still wins over the body+segments backfill", async () => {
    // Reasserts the existing precedence for the segment-aware path: an
    // admin's hand-typed M:SS is intentional and must not be overwritten
    // at read time, even when the computed full duration would differ.
    await seedSegment({ id: "intro-l", kind: "intro", durationMs: 4_000 });
    await seedSegment({ id: "outro-l", kind: "outro", durationMs: 3_000 });
    await seedStory("short-l", {
      duration: "1:23",
      lastRenderedSegments: {
        intro_segment_id: "intro-l",
        outro_segment_id: "outro-l",
      },
    });
    await seedShortRender({
      id: "render-l",
      storyId: "short-l",
      status: "done",
      props: { duration_ms: 42_000 },
      finishedAt: "2026-06-20T01:00:00.000Z",
    });
    const { loadLiveCatalog } = await import("@/lib/homepage-data");
    const result = await loadLiveCatalog();
    const story = result.stories.find((s) => s.id === "short-l");
    expect(story?.duration).toBe("1:23");
  });
});

describe("loadLiveCatalog prefers props.assembled_duration_ms (_plans/2026-06-29)", () => {
  it("uses the ffprobed assembled duration when present, ignoring the body+segments sum", async () => {
    // Production case from The Dress Disaster: body narration is 0:35
    // and intro+outro adds another ~7s, but the actual rendered MP4
    // plays for 0:44 because the splice adds tail pad + re-encode
    // rounding. assembled_duration_ms is the ground truth and the
    // reader must honor it.
    await seedSegment({ id: "intro-m", kind: "intro", durationMs: 4_000 });
    await seedSegment({ id: "outro-m", kind: "outro", durationMs: 3_000 });
    await seedStory("short-m", {
      lastRenderedSegments: {
        intro_segment_id: "intro-m",
        outro_segment_id: "outro-m",
      },
    });
    await seedShortRender({
      id: "render-m",
      storyId: "short-m",
      status: "done",
      props: { duration_ms: 35_000, assembled_duration_ms: 44_000 },
      finishedAt: "2026-06-20T01:00:00.000Z",
    });
    const { loadLiveCatalog } = await import("@/lib/homepage-data");
    const result = await loadLiveCatalog();
    const story = result.stories.find((s) => s.id === "short-m");
    expect(story?.duration).toBe("0:44");
  });

  it("uses assembled_duration_ms even when no stamp exists (newer renders skip the segment lookup)", async () => {
    // A render row that carries assembled_duration_ms doesn't need a
    // _last_rendered_segments stamp at all — the probed value is
    // already the post-splice length. Useful for the no-stamp legacy
    // path: ship a re-render and the value lands without backfilling
    // anything else.
    await seedStory("short-n");
    await seedShortRender({
      id: "render-n",
      storyId: "short-n",
      status: "done",
      props: { duration_ms: 35_000, assembled_duration_ms: 44_000 },
      finishedAt: "2026-06-20T01:00:00.000Z",
    });
    const { loadLiveCatalog } = await import("@/lib/homepage-data");
    const result = await loadLiveCatalog();
    const story = result.stories.find((s) => s.id === "short-n");
    expect(story?.duration).toBe("0:44");
  });

  it("ignores a non-positive or malformed assembled_duration_ms and falls back to the sum", async () => {
    // Defensive: a zero / negative / NaN value must not be honored —
    // drop back to the legacy body+intro+outro sum so the badge stays
    // sane on a malformed write.
    await seedSegment({ id: "intro-o", kind: "intro", durationMs: 4_000 });
    await seedStory("short-o", {
      lastRenderedSegments: {
        intro_segment_id: "intro-o",
        outro_segment_id: null,
      },
    });
    await seedShortRender({
      id: "render-o",
      storyId: "short-o",
      status: "done",
      props: { duration_ms: 30_000, assembled_duration_ms: 0 },
      finishedAt: "2026-06-20T01:00:00.000Z",
    });
    const { loadLiveCatalog } = await import("@/lib/homepage-data");
    const result = await loadLiveCatalog();
    const story = result.stories.find((s) => s.id === "short-o");
    expect(story?.duration).toBe("0:34");
  });

  it("admin-set stories.duration still wins over the assembled value", async () => {
    // A hand-typed override is intentional and must not be overwritten
    // even when we have ground truth from ffprobe.
    await seedStory("short-p", { duration: "1:23" });
    await seedShortRender({
      id: "render-p",
      storyId: "short-p",
      status: "done",
      props: { duration_ms: 35_000, assembled_duration_ms: 44_000 },
      finishedAt: "2026-06-20T01:00:00.000Z",
    });
    const { loadLiveCatalog } = await import("@/lib/homepage-data");
    const result = await loadLiveCatalog();
    const story = result.stories.find((s) => s.id === "short-p");
    expect(story?.duration).toBe("1:23");
  });
});
