// Tests for src/lib/video-config.ts — the editor's parse/validate boundary.
//
// Mirrors the coverage shape of pipeline/tests/test_video_config.py (the
// Python-side merge tests): exercise the validator's required fields,
// optional pass-throughs, schema-version migration, defensive trims of
// junk input, and the defaultVideoConfig() derivation from a raw StoryRow.
//
// Pure logic — no React, no DOM, no fetch. Run with `npm test`.

import { describe, expect, it } from "vitest";
import type { StoryRow } from "@/lib/repo";
import {
  applyConfigPatch,
  CURRENT_CONFIG_VERSION,
  defaultVideoConfig,
  migrateVideoConfig,
  mintFrameId,
  parseVideoConfig,
  type ShortVideoConfig,
} from "@/lib/video-config";

// ─── Test fixtures ────────────────────────────────────────────────────────────

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    voiceover_url: "/v.mp3",
    title: "Hi",
    channel_name: "lorewire",
    duration_ms: 10000,
    doodle_frames: [{ url: "/a.png", caption_chunk_start_index: 0 }],
    captions: [{ start_ms: 0, end_ms: 10000, text: "Hi" }],
    ...overrides,
  };
}

function emptyStoryRow(overrides: Partial<StoryRow> = {}): StoryRow {
  return {
    id: "test",
    reddit_id: null,
    slug: null,
    category: null,
    title: null,
    summary: null,
    body: null,
    teleprompter: null,
    status: null,
    source_url: null,
    hero_image: null,
    images: null,
    audio_url: null,
    video_url: null,
    duration: null,
    alignment: null,
    intro_segment_id: null,
    outro_segment_id: null,
    skip_intro: null,
    skip_outro: null,
    video_config: null,
    tokens: null,
    cost_cents: null,
    created_at: null,
    updated_at: null,
    published_at: null,
    payload: null,
    ...overrides,
  };
}

// ─── parseVideoConfig: required fields ────────────────────────────────────────

describe("parseVideoConfig — required fields", () => {
  it("accepts a minimal valid config", () => {
    const r = parseVideoConfig(validConfig());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.voiceover_url).toBe("/v.mp3");
      expect(r.config.config_version).toBe(CURRENT_CONFIG_VERSION);
    }
  });

  it("rejects non-object root", () => {
    expect(parseVideoConfig(null).ok).toBe(false);
    expect(parseVideoConfig("string").ok).toBe(false);
    expect(parseVideoConfig([]).ok).toBe(false);
    expect(parseVideoConfig(42).ok).toBe(false);
  });

  it("rejects missing voiceover_url", () => {
    const { voiceover_url: _drop, ...rest } = validConfig();
    void _drop;
    const r = parseVideoConfig(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/voiceover_url/);
  });

  it("rejects voiceover_url of wrong type", () => {
    const r = parseVideoConfig(validConfig({ voiceover_url: 42 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/voiceover_url.*string/);
  });

  it("rejects negative duration_ms", () => {
    const r = parseVideoConfig(validConfig({ duration_ms: -1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duration_ms/);
  });

  it("rejects non-finite duration_ms", () => {
    expect(parseVideoConfig(validConfig({ duration_ms: NaN })).ok).toBe(false);
    expect(parseVideoConfig(validConfig({ duration_ms: Infinity })).ok).toBe(
      false,
    );
  });

  it("rejects doodle_frames that's not an array", () => {
    const r = parseVideoConfig(validConfig({ doodle_frames: "nope" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/doodle_frames/);
  });

  it("propagates the failing index in a doodle_frame error path", () => {
    const r = parseVideoConfig(
      validConfig({
        doodle_frames: [
          { url: "/a.png", caption_chunk_start_index: 0 },
          { url: 42, caption_chunk_start_index: 1 }, // bad URL at idx 1
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/doodle_frames\[1\]/);
  });

  it("rejects caption chunk with end_ms < start_ms", () => {
    const r = parseVideoConfig(
      validConfig({
        captions: [{ start_ms: 5000, end_ms: 2000, text: "backwards" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/captions\[0\]/);
  });
});

// ─── parseVideoConfig: DoodleFrame schema (Phase 2) ───────────────────────────
//
// Phase 2 of the video editor overhaul
// (_plans/2026-06-12-video-editor-overhaul.md). Stable per-frame `id`,
// optional `image_prompt`, and one-step `prev_image` Revert snapshot.
// Legacy configs without `id` lazy-mint one at parse time; the next save
// persists the value.

describe("parseVideoConfig — DoodleFrame Phase 2 fields", () => {
  it("mints a stable id when a legacy config is missing the field", () => {
    const r = parseVideoConfig(
      validConfig({
        doodle_frames: [{ url: "/a.png", caption_chunk_start_index: 0 }],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.config.doodle_frames[0].id).toBe("string");
      expect(r.config.doodle_frames[0].id.length).toBeGreaterThan(0);
    }
  });

  it("preserves an existing id verbatim (round-trip)", () => {
    const r = parseVideoConfig(
      validConfig({
        doodle_frames: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            url: "/a.png",
            caption_chunk_start_index: 0,
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.doodle_frames[0].id).toBe(
        "00000000-0000-4000-8000-000000000001",
      );
    }
  });

  it("treats an empty-string id as missing and mints a fresh one", () => {
    const r = parseVideoConfig(
      validConfig({
        doodle_frames: [{ id: "", url: "/a.png", caption_chunk_start_index: 0 }],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.doodle_frames[0].id).not.toBe("");
      expect(r.config.doodle_frames[0].id.length).toBeGreaterThan(0);
    }
  });

  it("mints DIFFERENT ids across two parses of the same legacy input", () => {
    // Documents the lazy-mint contract: until the editor saves, ids are
    // ephemeral per parse. Once persisted, the parser preserves them.
    const raw = validConfig({
      doodle_frames: [{ url: "/a.png", caption_chunk_start_index: 0 }],
    });
    const a = parseVideoConfig(raw);
    const b = parseVideoConfig(raw);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.config.doodle_frames[0].id).not.toBe(
        b.config.doodle_frames[0].id,
      );
    }
  });

  it("preserves image_prompt when supplied as a non-empty string", () => {
    const r = parseVideoConfig(
      validConfig({
        doodle_frames: [
          {
            id: "f1",
            url: "/a.png",
            caption_chunk_start_index: 0,
            image_prompt: "a doodle of a confused accountant",
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.doodle_frames[0].image_prompt).toBe(
        "a doodle of a confused accountant",
      );
    }
  });

  it("omits image_prompt when empty, missing, or wrong type", () => {
    const cases = [
      { id: "f1", url: "/a.png", caption_chunk_start_index: 0 },
      { id: "f1", url: "/a.png", caption_chunk_start_index: 0, image_prompt: "" },
      { id: "f1", url: "/a.png", caption_chunk_start_index: 0, image_prompt: 42 },
      {
        id: "f1",
        url: "/a.png",
        caption_chunk_start_index: 0,
        image_prompt: null,
      },
    ];
    for (const frame of cases) {
      const r = parseVideoConfig(validConfig({ doodle_frames: [frame] }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.config.doodle_frames[0].image_prompt).toBeUndefined();
      }
    }
  });

  it("preserves a valid prev_image snapshot", () => {
    const r = parseVideoConfig(
      validConfig({
        doodle_frames: [
          {
            id: "f1",
            url: "/new.png",
            caption_chunk_start_index: 0,
            image_prompt: "new prompt",
            prev_image: {
              url: "/old.png",
              image_prompt: "old prompt",
              replaced_at: "2026-06-12T12:00:00Z",
            },
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.doodle_frames[0].prev_image).toEqual({
        url: "/old.png",
        image_prompt: "old prompt",
        replaced_at: "2026-06-12T12:00:00Z",
      });
    }
  });

  it("rejects prev_image with a missing field", () => {
    // The Revert action depends on all three fields being present; a
    // partial snapshot would silently corrupt the undo path.
    const r = parseVideoConfig(
      validConfig({
        doodle_frames: [
          {
            id: "f1",
            url: "/new.png",
            caption_chunk_start_index: 0,
            prev_image: { url: "/old.png", image_prompt: "old" }, // no replaced_at
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/prev_image|replaced_at/);
  });

  it("treats null prev_image as absent (the editor writes null to clear it)", () => {
    const r = parseVideoConfig(
      validConfig({
        doodle_frames: [
          {
            id: "f1",
            url: "/a.png",
            caption_chunk_start_index: 0,
            prev_image: null,
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.doodle_frames[0].prev_image).toBeUndefined();
    }
  });

  it("rejects a non-object prev_image", () => {
    const r = parseVideoConfig(
      validConfig({
        doodle_frames: [
          {
            id: "f1",
            url: "/a.png",
            caption_chunk_start_index: 0,
            prev_image: "not an object",
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/prev_image/);
  });
});

describe("mintFrameId", () => {
  it("returns a non-empty string", () => {
    const id = mintFrameId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("returns a unique value per call", () => {
    // The native crypto.randomUUID has a 122-bit entropy collision space,
    // so two calls in quick succession should never match in practice.
    // If this ever fires, something's wrong with the host's Web Crypto.
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(mintFrameId());
    expect(seen.size).toBe(100);
  });
});

// ─── parseVideoConfig: trim bounds ───────────────────────────────────────────

describe("parseVideoConfig — trim bounds", () => {
  it("accepts a trim window inside duration", () => {
    const r = parseVideoConfig(
      validConfig({ clip_start_ms: 1000, clip_end_ms: 8000 }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.clip_start_ms).toBe(1000);
      expect(r.config.clip_end_ms).toBe(8000);
    }
  });

  it("rejects clip_start_ms above duration", () => {
    const r = parseVideoConfig(validConfig({ clip_start_ms: 11000 }));
    expect(r.ok).toBe(false);
  });

  it("rejects clip_end_ms below clip_start_ms", () => {
    const r = parseVideoConfig(
      validConfig({ clip_start_ms: 5000, clip_end_ms: 4000 }),
    );
    expect(r.ok).toBe(false);
  });

  it("treats missing/null trim as unset (not 0)", () => {
    // Important: null and missing both mean "use full duration" — the
    // renderer treats absent as no-trim. If we coerced to 0 we'd silently
    // render zero frames.
    const r = parseVideoConfig(
      validConfig({ clip_start_ms: null, clip_end_ms: null }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.clip_start_ms).toBeUndefined();
      expect(r.config.clip_end_ms).toBeUndefined();
    }
  });
});

// ─── parseVideoConfig: optional pass-throughs ────────────────────────────────

describe("parseVideoConfig — optional pass-throughs", () => {
  it("preserves title, channel_name, ken_burns when valid", () => {
    const r = parseVideoConfig(
      validConfig({
        title: "Custom",
        channel_name: "@x",
        ken_burns: true,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.title).toBe("Custom");
      expect(r.config.channel_name).toBe("@x");
      expect(r.config.ken_burns).toBe(true);
    }
  });

  it("drops wrong-typed optional fields silently", () => {
    // The boundary stays additive: a bad optional field doesn't fail the
    // save, it just doesn't survive the parse.
    const r = parseVideoConfig(validConfig({ title: 42, ken_burns: "yes" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.title).toBeUndefined();
      expect(r.config.ken_burns).toBeUndefined();
    }
  });

  it("accepts a valid MusicTrack", () => {
    const r = parseVideoConfig(
      validConfig({ music: { url: "/m.mp3", gain_db: -12 } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.music).toEqual({ url: "/m.mp3", gain_db: -12 });
  });

  it("rejects music.gain_db out of range", () => {
    const r = parseVideoConfig(
      validConfig({ music: { url: "/m.mp3", gain_db: 100 } }),
    );
    expect(r.ok).toBe(false);
  });

  it("accepts a valid Overlay", () => {
    const r = parseVideoConfig(
      validConfig({
        overlays: [
          { start_ms: 0, end_ms: 2000, text: "boom", x: 0.5, y: 0.7 },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.overlays).toHaveLength(1);
  });

  it("rejects overlay coords outside [0,1]", () => {
    const r = parseVideoConfig(
      validConfig({
        overlays: [{ start_ms: 0, end_ms: 1, text: "x", x: 1.5, y: 0 }],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("only accepts true values in _locks", () => {
    // The pipeline merge ignores anything that isn't === true. Parser
    // strips falsy values so a corrupted editor write can't resurrect
    // stale locks.
    const r = parseVideoConfig(
      validConfig({ _locks: { title: true, body: false, foo: null } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config._locks).toEqual({ title: true });
  });

  it("accepts a valid EditSession", () => {
    const r = parseVideoConfig(
      validConfig({
        _edit_session: {
          user_id: "u1",
          started_at: "2026-06-11T00:00:00Z",
          heartbeat_at: "2026-06-11T00:01:00Z",
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config._edit_session?.user_id).toBe("u1");
  });

  it("preserves a valid MotionConfig (booleans only)", () => {
    const r = parseVideoConfig(
      validConfig({
        motion: {
          micro_wiggle: true,
          label_pop: false,
          // garbage values dropped
          scribble_draw: "yes",
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.motion?.micro_wiggle).toBe(true);
      expect(r.config.motion?.label_pop).toBe(false);
      expect(r.config.motion?.scribble_draw).toBeUndefined();
    }
  });
});

// ─── parseVideoConfig: aspect field (Phase 0 of the 16:9 plan) ───────────────

describe("parseVideoConfig — aspect field", () => {
  it("round-trips a per-story 16:9 aspect", () => {
    const r = parseVideoConfig(validConfig({ aspect: "16:9" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.aspect).toBe("16:9");
  });

  it("round-trips a per-story 9:16 aspect", () => {
    const r = parseVideoConfig(validConfig({ aspect: "9:16" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.aspect).toBe("9:16");
  });

  it("leaves aspect undefined when the field is missing (legacy back-compat)", () => {
    const r = parseVideoConfig(validConfig());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.aspect).toBeUndefined();
  });

  it("drops an unsupported aspect value rather than failing the parse", () => {
    const r = parseVideoConfig(validConfig({ aspect: "4:3" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.aspect).toBeUndefined();
  });

  it("drops a non-string aspect value", () => {
    const r = parseVideoConfig(validConfig({ aspect: 16 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.aspect).toBeUndefined();
  });
});

// ─── parseVideoConfig: unknown-field tolerance ───────────────────────────────

describe("parseVideoConfig — unknown-field tolerance", () => {
  it("drops unknown top-level fields without error", () => {
    // The council's "renderer treats unknown fields as no-ops" boundary
    // is enforced here. A future editor field that doesn't know about an
    // older renderer's schema shouldn't fail saves.
    const r = parseVideoConfig(
      validConfig({ futureField: { totallyNew: true } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(
        (r.config as unknown as Record<string, unknown>).futureField,
      ).toBeUndefined();
    }
  });

  it("stamps the current config_version on a valid v1 input", () => {
    const raw = validConfig({ config_version: 1 });
    const r = parseVideoConfig(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.config_version).toBe(CURRENT_CONFIG_VERSION);
  });
});

// ─── migrateVideoConfig ──────────────────────────────────────────────────────

describe("migrateVideoConfig", () => {
  it("stamps version on v1 → v2", () => {
    const out = migrateVideoConfig({ ...validConfig(), config_version: 1 });
    expect(out.config_version).toBe(CURRENT_CONFIG_VERSION);
  });

  it("treats missing version as v1", () => {
    const out = migrateVideoConfig(validConfig());
    expect(out.config_version).toBe(CURRENT_CONFIG_VERSION);
  });

  it("leaves current-version payloads alone", () => {
    const raw = { ...validConfig(), config_version: CURRENT_CONFIG_VERSION };
    const out = migrateVideoConfig(raw);
    expect(out).toBe(raw); // identity — no copy when already current
  });
});

// ─── defaultVideoConfig ──────────────────────────────────────────────────────

describe("defaultVideoConfig", () => {
  it("returns an empty-but-valid shape for a bare row", () => {
    const cfg = defaultVideoConfig(emptyStoryRow());
    expect(cfg.config_version).toBe(CURRENT_CONFIG_VERSION);
    expect(cfg.voiceover_url).toBe("");
    expect(cfg.duration_ms).toBe(0);
    expect(cfg.doodle_frames).toEqual([]);
    expect(cfg.captions).toEqual([]);
  });

  it("lifts title, audio_url, and parsed images/alignment from the row", () => {
    const story = emptyStoryRow({
      title: "Big news",
      audio_url: "/v.mp3",
      images: JSON.stringify(["/a.png", "/b.png"]),
      alignment: JSON.stringify([
        { start_ms: 0, end_ms: 3000, text: "Hi" },
        { start_ms: 3000, end_ms: 6000, text: "There" },
      ]),
    });
    const cfg = defaultVideoConfig(story);
    expect(cfg.title).toBe("Big news");
    expect(cfg.voiceover_url).toBe("/v.mp3");
    expect(cfg.doodle_frames).toHaveLength(2);
    expect(cfg.doodle_frames[0].url).toBe("/a.png");
    expect(cfg.duration_ms).toBe(6000);
  });

  it("handles word-level alignment shape (start/end in seconds)", () => {
    // Pre-video-editor pipeline writes alignment as word-level STT output:
    // `[{word, start, end}]` with start/end in *seconds*. defaultVideoConfig
    // must detect this shape and chunk it the way pipeline/video.py does —
    // otherwise duration_ms ends up NaN and the Player throws hard.
    const cfg = defaultVideoConfig(
      emptyStoryRow({
        audio_url: "/v.mp3",
        alignment: JSON.stringify([
          { word: "Hi",    start: 0.0, end: 0.2 },
          { word: "there", start: 0.2, end: 0.4 },
          { word: "world", start: 0.5, end: 0.7 },
        ]),
      }),
    );
    expect(cfg.captions.length).toBeGreaterThan(0);
    expect(cfg.duration_ms).toBe(700);
    expect(Number.isFinite(cfg.duration_ms)).toBe(true);
    // Every chunk has finite ms-scale timings.
    for (const c of cfg.captions) {
      expect(Number.isFinite(c.start_ms)).toBe(true);
      expect(Number.isFinite(c.end_ms)).toBe(true);
    }
  });

  it("never produces NaN duration_ms regardless of input", () => {
    // The Player throws `TypeError: durationInFrames must be an integer,
    // but got NaN` if even one upstream value is NaN. Lock the boundary
    // at the validator: result must be finite. (0 is allowed and treated
    // as "unknown" by the editor's downstream guards.)
    for (const alignment of [null, "", "[]", "garbage", "[{\"weird\": 1}]"]) {
      const cfg = defaultVideoConfig(
        emptyStoryRow({ audio_url: "/v.mp3", alignment }),
      );
      expect(Number.isFinite(cfg.duration_ms)).toBe(true);
      expect(cfg.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("tolerates malformed JSON in images / alignment", () => {
    // Corrupted columns shouldn't crash the editor on first open.
    const cfg = defaultVideoConfig(
      emptyStoryRow({ images: "{not json", alignment: "{also bad" }),
    );
    expect(cfg.doodle_frames).toEqual([]);
    expect(cfg.captions).toEqual([]);
  });

  it("round-trips cleanly through parseVideoConfig", () => {
    // The default shape must satisfy our own validator — otherwise the
    // very first editor open would surface a parse error to the admin.
    const cfg = defaultVideoConfig(
      emptyStoryRow({
        title: "Round trip",
        audio_url: "/v.mp3",
        images: JSON.stringify(["/a.png"]),
        alignment: JSON.stringify([
          { start_ms: 0, end_ms: 1000, text: "Hi" },
        ]),
      }),
    );
    const r = parseVideoConfig(cfg);
    expect(r.ok).toBe(true);
  });
});

// ─── applyConfigPatch ────────────────────────────────────────────────────────

describe("applyConfigPatch", () => {
  const base: ShortVideoConfig = {
    config_version: CURRENT_CONFIG_VERSION,
    voiceover_url: "/v.mp3",
    title: "Old",
    duration_ms: 10000,
    doodle_frames: [
      { id: "test-frame-a", url: "/a.png", caption_chunk_start_index: 0 },
    ],
    captions: [{ start_ms: 0, end_ms: 10000, text: "Hi" }],
  };

  it("shallow-merges patch keys over the base", () => {
    const out = applyConfigPatch(
      base,
      { title: "New", clip_start_ms: 1000, clip_end_ms: 8000 },
      ["title", "clip_start_ms", "clip_end_ms"],
    );
    expect(out.title).toBe("New");
    expect(out.clip_start_ms).toBe(1000);
    expect(out.clip_end_ms).toBe(8000);
    // Untouched required field still present.
    expect(out.voiceover_url).toBe("/v.mp3");
  });

  it("stamps each lock path into _locks", () => {
    const out = applyConfigPatch(base, { title: "New" }, ["title"]);
    expect(out._locks).toEqual({ title: true });
  });

  it("merges new locks on top of existing ones", () => {
    const withLocks: ShortVideoConfig = {
      ...base,
      _locks: { voiceover_url: true },
    };
    const out = applyConfigPatch(withLocks, { title: "X" }, ["title"]);
    expect(out._locks).toEqual({ voiceover_url: true, title: true });
  });

  it("ignores empty + non-string lock paths", () => {
    const out = applyConfigPatch(
      base,
      { title: "X" },
      ["title", "", null as unknown as string, undefined as unknown as string],
    );
    expect(out._locks).toEqual({ title: true });
  });

  it("rejects _locks and _edit_session in the patch payload", () => {
    // Editor must use dedicated unlock actions, not the generic save path.
    const out = applyConfigPatch(
      base,
      {
        _locks: { everything: true },
        _edit_session: { user_id: "x", started_at: "", heartbeat_at: "" },
        title: "Legit",
      },
      ["title"],
    );
    expect(out.title).toBe("Legit");
    expect(out._locks).toEqual({ title: true });
    expect(out._edit_session).toBeUndefined();
  });

  it("does not mutate the base config", () => {
    const out = applyConfigPatch(base, { title: "X" }, ["title"]);
    expect(out).not.toBe(base);
    expect(base.title).toBe("Old");
    expect(base._locks).toBeUndefined();
  });

  it("result round-trips through parseVideoConfig", () => {
    const out = applyConfigPatch(
      base,
      { clip_start_ms: 1000, clip_end_ms: 8000 },
      ["clip_start_ms", "clip_end_ms"],
    );
    const r = parseVideoConfig(out);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.clip_start_ms).toBe(1000);
      expect(r.config._locks?.clip_start_ms).toBe(true);
    }
  });

  it("removes paths listed in unlockPaths from _locks", () => {
    const withLocks: ShortVideoConfig = {
      ...base,
      _locks: { title: true, clip_start_ms: true },
    };
    const out = applyConfigPatch(withLocks, {}, [], ["title"]);
    expect(out._locks).toEqual({ clip_start_ms: true });
  });

  it("drops _locks entirely when unlocking the last entry", () => {
    const withLocks: ShortVideoConfig = {
      ...base,
      _locks: { title: true },
    };
    const out = applyConfigPatch(withLocks, {}, [], ["title"]);
    // Empty lock maps shouldn't linger on the row — drop the key so the
    // persisted JSON stays minimal and the parser treats it as "no locks".
    expect(out._locks).toBeUndefined();
  });

  it("ignores unlock paths that aren't currently locked", () => {
    const out = applyConfigPatch(base, {}, [], ["title", "nonsense"]);
    expect(out._locks).toBeUndefined();
  });

  it("overlays edit pattern: patches whole array + locks the overlays key", () => {
    // OverlaysPanel sends the full overlays array (add/edit/remove are
    // all expressed as array deltas the editor computes locally) plus a
    // single "overlays" lock path. Overlays are editor-only — the pipeline
    // never generates them — so locking the whole array (instead of
    // per-index) keeps the merge simple.
    const out = applyConfigPatch(
      base,
      {
        overlays: [
          { start_ms: 0, end_ms: 2000, text: "hello", x: 0.5, y: 0.4 },
          { start_ms: 4000, end_ms: 6000, text: "world", x: 0.5, y: 0.6 },
        ],
      },
      ["overlays"],
    );
    expect(out.overlays).toHaveLength(2);
    expect(out.overlays?.[0].text).toBe("hello");
    expect(out._locks).toEqual({ overlays: true });
    const r = parseVideoConfig(out);
    expect(r.ok).toBe(true);
  });

  it("audio edit pattern: patches music object + locks music.url + music.gain_db", () => {
    // AudioPanel sends the full music object on save so partial edits
    // (gain only / URL only) don't lose the other field. Lock paths are
    // per-field so the user can independently unlock either.
    const out = applyConfigPatch(
      base,
      { music: { url: "https://example.com/bg.mp3", gain_db: -8 } },
      ["music.url", "music.gain_db"],
    );
    expect(out.music?.url).toBe("https://example.com/bg.mp3");
    expect(out.music?.gain_db).toBe(-8);
    expect(out._locks).toEqual({
      "music.url": true,
      "music.gain_db": true,
    });
    const r = parseVideoConfig(out);
    expect(r.ok).toBe(true);
  });

  it("captions edit pattern: patches whole array + locks per-chunk text", () => {
    // The CaptionsPanel in EditorClient sends the whole captions array
    // (because the editor only sees them all together) plus per-chunk lock
    // paths for the chunks the user actually edited. This test pins that
    // contract end-to-end through applyConfigPatch → parseVideoConfig.
    const baseWithMultiChunk: ShortVideoConfig = {
      ...base,
      duration_ms: 6000,
      captions: [
        { start_ms: 0, end_ms: 2000, text: "one" },
        { start_ms: 2000, end_ms: 4000, text: "two" },
        { start_ms: 4000, end_ms: 6000, text: "three" },
      ],
    };
    const edited = [...baseWithMultiChunk.captions];
    edited[1] = { ...edited[1], text: "TWO!" };
    const out = applyConfigPatch(
      baseWithMultiChunk,
      { captions: edited },
      ["captions[1].text"],
    );
    expect(out.captions[1].text).toBe("TWO!");
    expect(out.captions[0].text).toBe("one");
    expect(out.captions[2].text).toBe("three");
    expect(out._locks).toEqual({ "captions[1].text": true });
    // And the result must round-trip — caption timings stay valid.
    const r = parseVideoConfig(out);
    expect(r.ok).toBe(true);
  });

  it("supports lock + unlock in the same call", () => {
    const withLocks: ShortVideoConfig = {
      ...base,
      _locks: { clip_end_ms: true },
    };
    const out = applyConfigPatch(
      withLocks,
      { title: "New" },
      ["title"],
      ["clip_end_ms"],
    );
    expect(out._locks).toEqual({ title: true });
  });

  it("invalid patch fails the post-merge validation", () => {
    // clip_end_ms below clip_start_ms — the patch itself is well-formed
    // but the resulting config is illegal. Caller (the server action) is
    // expected to run parseVideoConfig on the output and reject.
    const out = applyConfigPatch(
      base,
      { clip_start_ms: 5000, clip_end_ms: 2000 },
      ["clip_start_ms", "clip_end_ms"],
    );
    const r = parseVideoConfig(out);
    expect(r.ok).toBe(false);
  });
});
