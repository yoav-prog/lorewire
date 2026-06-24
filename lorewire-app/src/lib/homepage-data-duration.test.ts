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
}

async function seedStory(
  id: string,
  opts: { duration?: string | null; status?: string } = {},
): Promise<void> {
  await run(
    "INSERT INTO stories (id, slug, title, category, summary, status, duration, " +
      "created_at, published_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      `slug-${id}`,
      `Title ${id}`,
      "Drama",
      "synopsis",
      opts.status ?? "published",
      opts.duration ?? null,
      "2026-06-20T00:00:00.000Z",
      "2026-06-20T00:00:00.000Z",
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
});
