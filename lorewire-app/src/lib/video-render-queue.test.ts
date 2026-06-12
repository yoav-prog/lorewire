// Tests for the canonical hash. The DB-touching helpers (enqueueRender,
// getRender, latestRenderForStory) need a real driver and are exercised
// end-to-end by the Python queue tests on the same SQLite schema.
//
// What we lock down here: two functionally equivalent configs must hash
// the same (key order, lock changes, edit_session presence), and two
// configs that produce different MP4s must hash differently.

import { describe, expect, it } from "vitest";
import { hashConfig } from "@/lib/video-render-queue";
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
