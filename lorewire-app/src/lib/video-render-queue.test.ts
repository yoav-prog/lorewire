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
  forceEnqueueRender,
  hashConfig,
  isVideoRenderStale,
  listVideoRenderEvents,
  logVideoRenderEvent,
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

// ─── forceEnqueueRender — bypass idempotency ─────────────────────────────────
// The Force re-render button asks for a fresh row regardless of any
// existing row at the same (story, config_hash). These tests pin down
// that contract so the regular idempotency path doesn't accidentally
// merge them, and verify the new row carries a distinct config_hash
// suffix so the next enqueueRender for the same logical config still
// hits its own row.

describe("forceEnqueueRender — bypass semantics", () => {
  beforeEach(async () => {
    await run(`DELETE FROM video_renders WHERE story_id = ?`, [RETRY_STORY_ID]);
  });

  it("inserts a NEW row even when a done row already exists at the same config_hash", async () => {
    await run(
      `INSERT INTO video_renders
        (id, story_id, config_hash, status, progress, error, output_url,
         requested_by, requested_at, started_at, finished_at)
       VALUES (?, ?, ?, 'done', 1.0, NULL, 'https://gcs/x.mp4',
               'admin-1', '2026-06-14T10:00:00.000Z',
               '2026-06-14T10:01:00.000Z', '2026-06-14T10:05:00.000Z')`,
      ["force-1", RETRY_STORY_ID, RETRY_HASH],
    );

    const result = await forceEnqueueRender(
      RETRY_STORY_ID,
      RETRY_HASH,
      "admin-2",
    );

    expect(result.id).not.toBe("force-1");
    expect(result.status).toBe("queued");
    expect(result.requested_by).toBe("admin-2");
    // Suffix discriminator so the original row is untouched and the
    // new row doesn't collide with the next regular enqueue.
    expect(result.config_hash.startsWith(`${RETRY_HASH}:force-`)).toBe(true);

    const rows = await all<{ id: string; status: string }>(
      `SELECT id, status FROM video_renders WHERE story_id = ? ORDER BY requested_at ASC`,
      [RETRY_STORY_ID],
    );
    expect(rows).toHaveLength(2);
  });

  it("does NOT touch the existing row's state when forcing", async () => {
    await run(
      `INSERT INTO video_renders
        (id, story_id, config_hash, status, progress, error, output_url,
         requested_by, requested_at, started_at, finished_at)
       VALUES (?, ?, ?, 'error', 0, 'old failure', NULL,
               'admin-1', '2026-06-14T10:00:00.000Z', NULL,
               '2026-06-14T10:05:00.000Z')`,
      ["force-2", RETRY_STORY_ID, RETRY_HASH],
    );

    await forceEnqueueRender(RETRY_STORY_ID, RETRY_HASH, "admin-2");

    const original = await one<RenderRow>(
      `SELECT id, story_id, config_hash, status, progress, error, output_url,
              requested_by, requested_at, started_at, finished_at
       FROM video_renders WHERE id = ?`,
      ["force-2"],
    );
    expect(original?.status).toBe("error");
    expect(original?.error).toBe("old failure");
  });

  it("a subsequent regular enqueue at the same config_hash starts fresh (doesn't see the forced row)", async () => {
    await forceEnqueueRender(RETRY_STORY_ID, RETRY_HASH, "admin-1");
    const regular = await enqueueRender(
      RETRY_STORY_ID,
      RETRY_HASH,
      "admin-1",
    );
    expect(regular.status).toBe("queued");
    expect(regular.config_hash).toBe(RETRY_HASH);
    // Two rows total: the forced one + the regular one.
    const rows = await all<{ id: string }>(
      `SELECT id FROM video_renders WHERE story_id = ?`,
      [RETRY_STORY_ID],
    );
    expect(rows).toHaveLength(2);
  });
});

// ─── video_render_events — progress log ─────────────────────────────────────
// The editor's RenderControl reads this timeline to surface a live
// progress log under the Render button. Locking down the basic write +
// chronological read contract here.

const EVENT_RENDER_ID = "events-test-render";

describe("video_render_events helpers", () => {
  beforeEach(async () => {
    await run(`DELETE FROM video_render_events WHERE render_id = ?`, [
      EVENT_RENDER_ID,
    ]);
  });

  it("appends rows that listVideoRenderEvents returns in chronological order", async () => {
    await logVideoRenderEvent(EVENT_RENDER_ID, "queued", {
      message: "first",
    });
    await new Promise((r) => setTimeout(r, 5));
    await logVideoRenderEvent(EVENT_RENDER_ID, "claimed", {
      message: "second",
    });
    await new Promise((r) => setTimeout(r, 5));
    await logVideoRenderEvent(EVENT_RENDER_ID, "finished", {
      message: "third",
    });

    const rows = await listVideoRenderEvents(EVENT_RENDER_ID);
    expect(rows.map((r) => r.event)).toEqual([
      "queued",
      "claimed",
      "finished",
    ]);
    expect(rows.map((r) => r.message)).toEqual(["first", "second", "third"]);
  });

  it("stringifies payload to JSON exactly once", async () => {
    await logVideoRenderEvent(EVENT_RENDER_ID, "cloud_run_failure", {
      level: "error",
      message: "503",
      payload: { http_status: 503, body: "internal" },
    });

    const rows = await listVideoRenderEvents(EVENT_RENDER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe("error");
    expect(rows[0].payload).toBe(
      JSON.stringify({ http_status: 503, body: "internal" }),
    );
  });

  it("writes message=null and payload=null when omitted (no default JSON)", async () => {
    await logVideoRenderEvent(EVENT_RENDER_ID, "queued");
    const rows = await listVideoRenderEvents(EVENT_RENDER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBeNull();
    expect(rows[0].payload).toBeNull();
    expect(rows[0].level).toBe("info");
  });

  it("isolates by render_id (other render's events don't leak in)", async () => {
    await logVideoRenderEvent(EVENT_RENDER_ID, "queued");
    await logVideoRenderEvent("other-render", "queued");
    const rows = await listVideoRenderEvents(EVENT_RENDER_ID);
    expect(rows).toHaveLength(1);
  });
});

describe("enqueueRender — event emission", () => {
  beforeEach(async () => {
    await run(`DELETE FROM video_renders WHERE story_id = ?`, [RETRY_STORY_ID]);
    // Clean any event rows we'd be checking; the test asserts against
    // the render id returned from enqueueRender so we don't know it up
    // front and just wipe by story_id-prefix via a join.
    await run(
      `DELETE FROM video_render_events
       WHERE render_id IN (
         SELECT id FROM video_renders WHERE story_id = ?
       )`,
      [RETRY_STORY_ID],
    );
  });

  it("emits a 'queued' event on first insert", async () => {
    const row = await enqueueRender(RETRY_STORY_ID, RETRY_HASH, "admin-1");
    const events = await listVideoRenderEvents(row.id);
    expect(events.map((e) => e.event)).toContain("queued");
  });

  it("emits a 'reset_from_error' event when resetting an errored row", async () => {
    await run(
      `INSERT INTO video_renders
        (id, story_id, config_hash, status, progress, error, output_url,
         requested_by, requested_at, started_at, finished_at)
       VALUES (?, ?, ?, 'error', 0, 'transient', NULL,
               'admin-1', '2026-06-14T10:00:00.000Z', NULL,
               '2026-06-14T10:05:00.000Z')`,
      ["reset-evt-1", RETRY_STORY_ID, RETRY_HASH],
    );

    await enqueueRender(RETRY_STORY_ID, RETRY_HASH, "admin-2");
    const events = await listVideoRenderEvents("reset-evt-1");
    expect(events.map((e) => e.event)).toContain("reset_from_error");
  });

  it("emits an 'idempotent_hit' event when the existing row is done", async () => {
    await run(
      `INSERT INTO video_renders
        (id, story_id, config_hash, status, progress, error, output_url,
         requested_by, requested_at, started_at, finished_at)
       VALUES (?, ?, ?, 'done', 1.0, NULL, 'https://gcs/x.mp4',
               'admin-1', '2026-06-14T10:00:00.000Z',
               '2026-06-14T10:01:00.000Z', '2026-06-14T10:05:00.000Z')`,
      ["idem-evt-1", RETRY_STORY_ID, RETRY_HASH],
    );

    await enqueueRender(RETRY_STORY_ID, RETRY_HASH, "admin-2");
    const events = await listVideoRenderEvents("idem-evt-1");
    expect(events.map((e) => e.event)).toContain("idempotent_hit");
  });
});
