// Tests for the canonical hash. The DB-touching helpers (enqueueRender,
// getRender, latestRenderForStory) need a real driver and are exercised
// end-to-end by the Python queue tests on the same SQLite schema.
//
// What we lock down here: two functionally equivalent configs must hash
// the same (key order, lock changes, edit_session presence), and two
// configs that produce different MP4s must hash differently.

import { describe, expect, it, beforeEach } from "vitest";
import { all, one, run } from "@/lib/db";
import {
  enqueueRender,
  hashConfig,
  isVideoRenderStale,
  type RenderRow,
} from "@/lib/video-render-queue";
import type { ShortVideoConfig } from "@/lib/video-config";

function baseConfig(overrides: Partial<ShortVideoConfig> = {}): ShortVideoConfig {
  return {
    config_version: 2,
    voiceover_url: "/v.mp3",
    title: "Hi",
    duration_ms: 10000,
    doodle_frames: [{ id: "test-frame-a", url: "/a.png", caption_chunk_start_index: 0 }],
    captions: [{ start_ms: 0, end_ms: 10000, text: "Hi" }],
    ...overrides,
  };
}

describe("hashConfig — canonical equality", () => {
  it("returns a stable hex digest", () => {
    const h = hashConfig(baseConfig());
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is insensitive to key order", () => {
    const a = hashConfig(baseConfig());
    const b = hashConfig(
      // Same fields, different declaration order.
      {
        captions: [{ start_ms: 0, end_ms: 10000, text: "Hi" }],
        duration_ms: 10000,
        config_version: 2,
        title: "Hi",
        voiceover_url: "/v.mp3",
        doodle_frames: [{ id: "test-frame-a", url: "/a.png", caption_chunk_start_index: 0 }],
      },
    );
    expect(a).toBe(b);
  });

  it("ignores _locks entirely", () => {
    const a = hashConfig(baseConfig());
    const b = hashConfig(baseConfig({ _locks: { title: true } }));
    // Locks don't change the rendered MP4 — they're an editor-only
    // concept — so hash should match.
    expect(a).toBe(b);
  });

  it("ignores _edit_session", () => {
    const a = hashConfig(baseConfig());
    const b = hashConfig(
      baseConfig({
        _edit_session: {
          user_id: "u1",
          started_at: "2026-06-11T00:00:00Z",
          heartbeat_at: "2026-06-11T00:01:00Z",
        },
      }),
    );
    expect(a).toBe(b);
  });

  it("ignores config_version (so v1→v2 doesn't re-render)", () => {
    const a = hashConfig(baseConfig({ config_version: 2 }));
    const b = hashConfig(baseConfig({ config_version: 1 }));
    expect(a).toBe(b);
  });
});

describe("hashConfig — change detection", () => {
  it("changes when title changes", () => {
    expect(hashConfig(baseConfig({ title: "A" }))).not.toBe(
      hashConfig(baseConfig({ title: "B" })),
    );
  });

  it("changes when clip_start_ms changes", () => {
    expect(hashConfig(baseConfig())).not.toBe(
      hashConfig(baseConfig({ clip_start_ms: 1000 })),
    );
  });

  it("changes when clip_end_ms changes", () => {
    expect(hashConfig(baseConfig({ clip_end_ms: 8000 }))).not.toBe(
      hashConfig(baseConfig({ clip_end_ms: 5000 })),
    );
  });

  it("changes when a caption text changes", () => {
    const a = hashConfig(
      baseConfig({
        captions: [{ start_ms: 0, end_ms: 10000, text: "Hello" }],
      }),
    );
    const b = hashConfig(
      baseConfig({
        captions: [{ start_ms: 0, end_ms: 10000, text: "World" }],
      }),
    );
    expect(a).not.toBe(b);
  });

  it("changes when a doodle frame is added", () => {
    const a = hashConfig(baseConfig());
    const b = hashConfig(
      baseConfig({
        doodle_frames: [
          { id: "test-frame-a", url: "/a.png", caption_chunk_start_index: 0 },
          { id: "test-frame-b", url: "/b.png", caption_chunk_start_index: 0 },
        ],
      }),
    );
    expect(a).not.toBe(b);
  });

  it("changes when music URL changes", () => {
    const a = hashConfig(baseConfig({ music: { url: "/a.mp3", gain_db: -12 } }));
    const b = hashConfig(baseConfig({ music: { url: "/b.mp3", gain_db: -12 } }));
    expect(a).not.toBe(b);
  });

  it("changes when music gain changes", () => {
    const a = hashConfig(baseConfig({ music: { url: "/a.mp3", gain_db: -12 } }));
    const b = hashConfig(baseConfig({ music: { url: "/a.mp3", gain_db: -6 } }));
    expect(a).not.toBe(b);
  });
});

// ─── isVideoRenderStale (Phase 4) ─────────────────────────────────────────────

const STORY_ID = "stale-test-story";

async function insertVideoRender(opts: {
  id: string;
  story_id?: string;
  requested_at: string;
}) {
  await run(
    `INSERT INTO video_renders
       (id, story_id, config_hash, status, progress, error, output_url,
        requested_by, requested_at, started_at, finished_at)
     VALUES (?, ?, 'hash', 'queued', 0, NULL, NULL, 'admin-1', ?, NULL, NULL)`,
    [opts.id, opts.story_id ?? STORY_ID, opts.requested_at],
  );
}

async function insertFrameRender(opts: {
  id: string;
  story_id?: string;
  asset?: string;
  status?: "queued" | "generating" | "done" | "error";
  finished_at: string | null;
}) {
  await run(
    `INSERT INTO image_renders
      (id, owner_kind, owner_id, asset, prompt_hash, status, progress, error,
       output_url, cost_cents, requested_by, requested_at, started_at, finished_at)
     VALUES (?, 'story', ?, ?, NULL, ?, 0, NULL, NULL, NULL, 'admin-1',
             '2026-06-12T10:00:00.000Z', NULL, ?)`,
    [
      opts.id,
      opts.story_id ?? STORY_ID,
      opts.asset ?? "frame:f1",
      opts.status ?? "done",
      opts.finished_at,
    ],
  );
}

describe("isVideoRenderStale", () => {
  beforeEach(async () => {
    // Clean ALL test rows (this story + the "other story" we use to
    // verify isolation) so cross-test id collisions don't trip the
    // image_renders UNIQUE constraint.
    await run(`DELETE FROM video_renders WHERE story_id IN (?, ?)`, [
      STORY_ID,
      "other-story",
    ]);
    await run(`DELETE FROM image_renders WHERE owner_id IN (?, ?)`, [
      STORY_ID,
      "other-story",
    ]);
  });

  it("returns false when the story has never been rendered", async () => {
    expect(await isVideoRenderStale(STORY_ID)).toBe(false);
  });

  it("returns false when there are no frame regens", async () => {
    await insertVideoRender({
      id: "v1",
      requested_at: "2026-06-12T11:00:00.000Z",
    });
    expect(await isVideoRenderStale(STORY_ID)).toBe(false);
  });

  it("returns true when a frame regen finished AFTER the latest render", async () => {
    await insertVideoRender({
      id: "v1",
      requested_at: "2026-06-12T11:00:00.000Z",
    });
    await insertFrameRender({
      id: "fr1",
      status: "done",
      finished_at: "2026-06-12T11:30:00.000Z",
    });
    expect(await isVideoRenderStale(STORY_ID)).toBe(true);
  });

  it("returns false when frame regens all happened before the latest render", async () => {
    await insertFrameRender({
      id: "fr1",
      status: "done",
      finished_at: "2026-06-12T10:30:00.000Z",
    });
    await insertVideoRender({
      id: "v1",
      requested_at: "2026-06-12T11:00:00.000Z",
    });
    expect(await isVideoRenderStale(STORY_ID)).toBe(false);
  });

  it("ignores in-flight frame regens (only completed counts)", async () => {
    await insertVideoRender({
      id: "v1",
      requested_at: "2026-06-12T11:00:00.000Z",
    });
    await insertFrameRender({
      id: "fr1",
      status: "queued",
      finished_at: null,
    });
    expect(await isVideoRenderStale(STORY_ID)).toBe(false);
  });

  it("ignores other stories' renders", async () => {
    await insertVideoRender({
      id: "v1",
      requested_at: "2026-06-12T11:00:00.000Z",
    });
    await insertFrameRender({
      id: "fr1",
      story_id: "other-story",
      status: "done",
      finished_at: "2026-06-12T11:30:00.000Z",
    });
    expect(await isVideoRenderStale(STORY_ID)).toBe(false);
  });

  it("ignores non-frame assets (scene/prop/hero regens don't count)", async () => {
    await insertVideoRender({
      id: "v1",
      requested_at: "2026-06-12T11:00:00.000Z",
    });
    await insertFrameRender({
      id: "fr1",
      asset: "scene:0",
      status: "done",
      finished_at: "2026-06-12T11:30:00.000Z",
    });
    expect(await isVideoRenderStale(STORY_ID)).toBe(false);
  });
});

// ─── enqueueRender — retry-after-error path ─────────────────────────────────
// The idempotency-on-(story, config_hash) key blocks the user from kicking
// a fresh render when nothing about the config changed. That's correct for
// the in-flight case (don't queue duplicates) and for already-done renders
// (no work to do). It's wrong for `error` rows: a transient infra failure
// would otherwise pin the user to a dead row until they edited the config.
// These tests pin down the reset-to-queued behavior so a regression
// silently re-blocks retries.

const RETRY_STORY_ID = "retry-test-story";
const RETRY_HASH = "retryhash";

async function getRetryRow(): Promise<RenderRow | null> {
  return one<RenderRow>(
    `SELECT id, story_id, config_hash, status, progress, error, output_url,
            requested_by, requested_at, started_at, finished_at
     FROM video_renders WHERE story_id = ? AND config_hash = ?`,
    [RETRY_STORY_ID, RETRY_HASH],
  );
}

describe("enqueueRender — retry semantics", () => {
  beforeEach(async () => {
    await run(`DELETE FROM video_renders WHERE story_id = ?`, [RETRY_STORY_ID]);
  });

  it("resets an errored row back to queued (preserves id)", async () => {
    await run(
      `INSERT INTO video_renders
        (id, story_id, config_hash, status, progress, error, output_url,
         requested_by, requested_at, started_at, finished_at)
       VALUES (?, ?, ?, 'error', 0.5, 'Cloud Run failed', NULL,
               'admin-1', '2026-06-14T10:00:00.000Z',
               '2026-06-14T10:01:00.000Z', '2026-06-14T10:05:00.000Z')`,
      ["retry-1", RETRY_STORY_ID, RETRY_HASH],
    );

    const result = await enqueueRender(RETRY_STORY_ID, RETRY_HASH, "admin-2");

    expect(result.id).toBe("retry-1");
    expect(result.status).toBe("queued");
    expect(result.error).toBeNull();
    expect(result.progress).toBe(0);
    expect(result.output_url).toBeNull();
    expect(result.started_at).toBeNull();
    expect(result.finished_at).toBeNull();
    expect(result.requested_by).toBe("admin-2");
    expect(result.requested_at).not.toBe("2026-06-14T10:00:00.000Z");

    const rows = await all<{ id: string }>(
      `SELECT id FROM video_renders WHERE story_id = ?`,
      [RETRY_STORY_ID],
    );
    expect(rows).toHaveLength(1);
  });

  it("does NOT touch a queued row (no double-claim)", async () => {
    await run(
      `INSERT INTO video_renders
        (id, story_id, config_hash, status, progress, error, output_url,
         requested_by, requested_at, started_at, finished_at)
       VALUES (?, ?, ?, 'queued', 0, NULL, NULL,
               'admin-1', '2026-06-14T10:00:00.000Z', NULL, NULL)`,
      ["retry-2", RETRY_STORY_ID, RETRY_HASH],
    );

    const result = await enqueueRender(RETRY_STORY_ID, RETRY_HASH, "admin-2");
    expect(result.id).toBe("retry-2");
    expect(result.requested_by).toBe("admin-1");
    expect(result.requested_at).toBe("2026-06-14T10:00:00.000Z");
  });

  it("does NOT touch a rendering row (mid-render)", async () => {
    await run(
      `INSERT INTO video_renders
        (id, story_id, config_hash, status, progress, error, output_url,
         requested_by, requested_at, started_at, finished_at)
       VALUES (?, ?, ?, 'rendering', 0.4, NULL, NULL,
               'admin-1', '2026-06-14T10:00:00.000Z',
               '2026-06-14T10:01:00.000Z', NULL)`,
      ["retry-3", RETRY_STORY_ID, RETRY_HASH],
    );

    const result = await enqueueRender(RETRY_STORY_ID, RETRY_HASH, "admin-2");
    expect(result.id).toBe("retry-3");
    expect(result.status).toBe("rendering");
    expect(result.progress).toBe(0.4);
  });

  it("does NOT touch a done row (already rendered)", async () => {
    await run(
      `INSERT INTO video_renders
        (id, story_id, config_hash, status, progress, error, output_url,
         requested_by, requested_at, started_at, finished_at)
       VALUES (?, ?, ?, 'done', 1.0, NULL, 'https://gcs/x.mp4',
               'admin-1', '2026-06-14T10:00:00.000Z',
               '2026-06-14T10:01:00.000Z', '2026-06-14T10:05:00.000Z')`,
      ["retry-4", RETRY_STORY_ID, RETRY_HASH],
    );

    const result = await enqueueRender(RETRY_STORY_ID, RETRY_HASH, "admin-2");
    expect(result.id).toBe("retry-4");
    expect(result.status).toBe("done");
    expect(result.output_url).toBe("https://gcs/x.mp4");
  });

  it("inserts a fresh row when none exists for (story, hash)", async () => {
    const result = await enqueueRender(RETRY_STORY_ID, RETRY_HASH, "admin-1");
    expect(result.status).toBe("queued");
    expect(result.config_hash).toBe(RETRY_HASH);

    const persisted = await getRetryRow();
    expect(persisted?.id).toBe(result.id);
  });
});
