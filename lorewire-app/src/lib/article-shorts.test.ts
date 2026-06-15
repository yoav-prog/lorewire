// Tests for the article -> story -> short_render -> frames chain that drives
// the ShortScenesPanel in the article editor. We exercise the helpers against
// the same SQLite test seam the other DB-touching suites use (per-process
// temp DB, set up in tests/setup.ts).

import { describe, expect, it, beforeEach } from "vitest";
import { run } from "@/lib/db";
import {
  getLinkedShortFrame,
  getLinkedShortFrames,
} from "@/lib/article-shorts";

async function reset(): Promise<void> {
  // Wipe rows from the tables this suite touches. Schema persists across runs
  // (matches the other tests in this dir). DELETE rather than TRUNCATE so
  // SQLite + Postgres take the same path.
  await run("DELETE FROM short_renders WHERE 1=1", []);
  await run("DELETE FROM articles WHERE 1=1", []);
  await run("DELETE FROM stories WHERE 1=1", []);
}

async function seedArticle(id: string, storyId: string | null): Promise<void> {
  await run(
    "INSERT INTO articles (id, type, language, slug, title, status, story_id, created_at, updated_at) " +
      "VALUES (?, 'feature', 'en', ?, ?, 'draft', ?, ?, ?)",
    [
      id,
      `slug-${id}`,
      `Title ${id}`,
      storyId,
      "2026-06-15T00:00:00.000Z",
      "2026-06-15T00:00:00.000Z",
    ],
  );
}

async function seedStory(id: string, title: string): Promise<void> {
  await run(
    "INSERT INTO stories (id, slug, title, status) VALUES (?, ?, ?, 'ready')",
    [id, `story-${id}`, title],
  );
}

async function seedShortRender(opts: {
  id: string;
  storyId: string;
  status: string;
  props: unknown;
  finishedAt?: string;
}): Promise<void> {
  // config_hash must be unique per (story_id, config_hash); we use the row
  // id as the hash so a test can stack multiple renders for the same story
  // without tripping the UNIQUE index in POST_TABLE_DDL.
  await run(
    "INSERT INTO short_renders (id, story_id, config_hash, status, progress, props, requested_at, finished_at) " +
      "VALUES (?, ?, ?, ?, 1, ?, '2026-06-15T00:00:00.000Z', ?)",
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

const SAMPLE_FRAMES = [
  { id: "frame-00", url: "https://gcs/sample/frame-00.png", caption_chunk_start_index: 0 },
  { id: "frame-01", url: "https://gcs/sample/frame-01.png", caption_chunk_start_index: 3 },
  { id: "frame-02", url: "https://gcs/sample/frame-02.png", caption_chunk_start_index: 6 },
];

beforeEach(async () => {
  await reset();
});

describe("getLinkedShortFrames", () => {
  it("returns null when the article has no linked story", async () => {
    await seedArticle("art-no-link", null);
    expect(await getLinkedShortFrames("art-no-link")).toBeNull();
  });

  it("returns null when the article does not exist", async () => {
    expect(await getLinkedShortFrames("does-not-exist")).toBeNull();
  });

  it("returns null when the linked story has no successful short_render", async () => {
    await seedStory("story-a", "Story A");
    await seedArticle("art-no-render", "story-a");
    // A queued or erroring row is not 'done' and should be filtered out.
    await seedShortRender({
      id: "render-queued",
      storyId: "story-a",
      status: "queued",
      props: { doodle_frames: SAMPLE_FRAMES },
    });
    expect(await getLinkedShortFrames("art-no-render")).toBeNull();
  });

  it("returns null when props is missing or unparseable", async () => {
    await seedStory("story-b", "Story B");
    await seedArticle("art-bad-props", "story-b");
    await seedShortRender({
      id: "render-no-props",
      storyId: "story-b",
      status: "done",
      props: null,
      finishedAt: "2026-06-15T01:00:00.000Z",
    });
    expect(await getLinkedShortFrames("art-bad-props")).toBeNull();

    // Replace with a row that has non-JSON props.
    await run("DELETE FROM short_renders WHERE id = ?", ["render-no-props"]);
    await run(
      "INSERT INTO short_renders (id, story_id, config_hash, status, progress, props, requested_at, finished_at) " +
        "VALUES (?, ?, ?, 'done', 1, ?, '2026-06-15T00:00:00.000Z', '2026-06-15T01:00:00.000Z')",
      ["render-bad-json", "story-b", "render-bad-json", "{not json}"],
    );
    expect(await getLinkedShortFrames("art-bad-props")).toBeNull();
  });

  it("returns null when props has no doodle_frames or it's empty", async () => {
    await seedStory("story-c", "Story C");
    await seedArticle("art-empty-frames", "story-c");
    await seedShortRender({
      id: "render-no-frames",
      storyId: "story-c",
      status: "done",
      props: { something_else: true },
      finishedAt: "2026-06-15T01:00:00.000Z",
    });
    expect(await getLinkedShortFrames("art-empty-frames")).toBeNull();

    await run("DELETE FROM short_renders WHERE id = ?", ["render-no-frames"]);
    await seedShortRender({
      id: "render-empty-array",
      storyId: "story-c",
      status: "done",
      props: { doodle_frames: [] },
      finishedAt: "2026-06-15T01:00:00.000Z",
    });
    expect(await getLinkedShortFrames("art-empty-frames")).toBeNull();
  });

  it("returns the latest done render's frames", async () => {
    await seedStory("story-d", "Story D");
    await seedArticle("art-happy", "story-d");
    // Older done render — should be ignored.
    await seedShortRender({
      id: "render-old",
      storyId: "story-d",
      status: "done",
      props: {
        doodle_frames: [
          { id: "old-00", url: "https://gcs/old/00.png", caption_chunk_start_index: 0 },
        ],
      },
      finishedAt: "2026-06-15T00:30:00.000Z",
    });
    // Newer done render — should win.
    await seedShortRender({
      id: "render-new",
      storyId: "story-d",
      status: "done",
      props: { doodle_frames: SAMPLE_FRAMES },
      finishedAt: "2026-06-15T01:00:00.000Z",
    });
    const result = await getLinkedShortFrames("art-happy");
    expect(result).not.toBeNull();
    expect(result!.storyId).toBe("story-d");
    expect(result!.storyTitle).toBe("Story D");
    expect(result!.shortRenderId).toBe("render-new");
    expect(result!.frames).toEqual(SAMPLE_FRAMES);
  });

  it("tolerates a dangling story_id (story deleted after link)", async () => {
    // Article links to a story that does not exist, but the short_render for
    // that story is still in the DB. We still surface the frames so the
    // editor's panel keeps working — the widget displays "(deleted)".
    await seedArticle("art-dangling", "ghost-story");
    await seedShortRender({
      id: "render-orphan",
      storyId: "ghost-story",
      status: "done",
      props: { doodle_frames: SAMPLE_FRAMES },
      finishedAt: "2026-06-15T01:00:00.000Z",
    });
    const result = await getLinkedShortFrames("art-dangling");
    expect(result).not.toBeNull();
    expect(result!.storyTitle).toBeNull();
    expect(result!.frames).toHaveLength(SAMPLE_FRAMES.length);
  });

  it("drops malformed frames but keeps the well-formed ones", async () => {
    await seedStory("story-e", "Story E");
    await seedArticle("art-mixed", "story-e");
    await seedShortRender({
      id: "render-mixed",
      storyId: "story-e",
      status: "done",
      props: {
        doodle_frames: [
          { id: "frame-good", url: "https://gcs/good.png", caption_chunk_start_index: 0 },
          { id: "frame-no-url" }, // missing url -> dropped
          null, // not an object -> dropped
          { url: "https://gcs/no-id.png" }, // missing id -> dropped
        ],
      },
      finishedAt: "2026-06-15T01:00:00.000Z",
    });
    const result = await getLinkedShortFrames("art-mixed");
    expect(result).not.toBeNull();
    expect(result!.frames).toHaveLength(1);
    expect(result!.frames[0].id).toBe("frame-good");
  });
});

describe("getLinkedShortFrame", () => {
  it("returns the single frame matching the supplied id", async () => {
    await seedStory("story-f", "Story F");
    await seedArticle("art-pick", "story-f");
    await seedShortRender({
      id: "render-pick",
      storyId: "story-f",
      status: "done",
      props: { doodle_frames: SAMPLE_FRAMES },
      finishedAt: "2026-06-15T01:00:00.000Z",
    });
    const frame = await getLinkedShortFrame("art-pick", "frame-01");
    expect(frame).not.toBeNull();
    expect(frame!.id).toBe("frame-01");
    expect(frame!.url).toBe("https://gcs/sample/frame-01.png");
    expect(frame!.caption_chunk_start_index).toBe(3);
  });

  it("returns null when the frame_id is not in the linked render", async () => {
    await seedStory("story-g", "Story G");
    await seedArticle("art-no-frame", "story-g");
    await seedShortRender({
      id: "render-no-frame",
      storyId: "story-g",
      status: "done",
      props: { doodle_frames: SAMPLE_FRAMES },
      finishedAt: "2026-06-15T01:00:00.000Z",
    });
    expect(await getLinkedShortFrame("art-no-frame", "ghost-frame")).toBeNull();
  });

  it("returns null when the article has no link", async () => {
    await seedArticle("art-no-link-2", null);
    expect(await getLinkedShortFrame("art-no-link-2", "frame-00")).toBeNull();
  });
});
