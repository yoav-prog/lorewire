// Tests for the ShortConfig schema + seeder + patcher (lib/short-config.ts).
// Phase 1 of _plans/2026-06-16-short-editor-full-parity.md. Pure functions;
// no DB needed.

import { describe, expect, it } from "vitest";
import {
  CURRENT_SHORT_CONFIG_VERSION,
  applyShortConfigPatch,
  defaultShortConfig,
  parseShortConfig,
  type ShortConfig,
} from "@/lib/short-config";

function baseConfig(over: Partial<ShortConfig> = {}): ShortConfig {
  return {
    config_version: CURRENT_SHORT_CONFIG_VERSION,
    doodle_frames: [
      { id: "frame-00", url: "https://gcs/00.png", caption_chunk_start_index: 0 },
      { id: "frame-01", url: "https://gcs/01.png", caption_chunk_start_index: 3 },
    ],
    captions: [
      { start_ms: 0, end_ms: 2000, text: "Once upon a time" },
      { start_ms: 2000, end_ms: 4500, text: "in an office" },
    ],
    ...over,
  };
}

describe("parseShortConfig", () => {
  it("accepts a minimal config", () => {
    const result = parseShortConfig({
      doodle_frames: [],
      captions: [],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects non-object roots", () => {
    expect(parseShortConfig(null).ok).toBe(false);
    expect(parseShortConfig("nope").ok).toBe(false);
    expect(parseShortConfig([]).ok).toBe(false);
  });

  it("rejects frames missing id or url", () => {
    const r = parseShortConfig({
      doodle_frames: [{ id: "frame-00" }], // url missing
      captions: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("url");
  });

  it("rejects captions with end_ms < start_ms", () => {
    const r = parseShortConfig({
      doodle_frames: [],
      captions: [{ start_ms: 5000, end_ms: 1000, text: "bad" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("captions[0]");
  });

  it("drops unknown top-level fields silently", () => {
    const r = parseShortConfig({
      doodle_frames: [],
      captions: [],
      something_weird: "ignored",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect("something_weird" in r.config).toBe(false);
    }
  });

  it("round-trips is_pinned, alt, image_prompt, prev_image", () => {
    const r = parseShortConfig({
      doodle_frames: [
        {
          id: "frame-00",
          url: "https://gcs/00.png",
          caption_chunk_start_index: 0,
          image_prompt: "a forest",
          alt: "forest scene",
          is_pinned: true,
          prev_image: {
            url: "https://gcs/00-old.png",
            image_prompt: "a meadow",
            replaced_at: "2026-06-16T10:00:00.000Z",
          },
        },
      ],
      captions: [],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const f = r.config.doodle_frames[0];
      expect(f.is_pinned).toBe(true);
      expect(f.alt).toBe("forest scene");
      expect(f.image_prompt).toBe("a forest");
      expect(f.prev_image?.url).toBe("https://gcs/00-old.png");
    }
  });
});

describe("defaultShortConfig", () => {
  const story = { id: "story-1" };

  it("returns null when there is no short_render", () => {
    expect(defaultShortConfig(story, null)).toBeNull();
  });

  it("returns null when props is missing or unparseable", () => {
    expect(
      defaultShortConfig(story, {
        id: "r-1",
        narration_style: "suspense",
        length_preset: "standard",
        props: null,
      }),
    ).toBeNull();
    expect(
      defaultShortConfig(story, {
        id: "r-2",
        narration_style: null,
        length_preset: null,
        props: "{not json}",
      }),
    ).toBeNull();
  });

  it("returns null when doodle_frames is missing or empty", () => {
    const r = defaultShortConfig(story, {
      id: "r-3",
      narration_style: null,
      length_preset: null,
      props: JSON.stringify({ doodle_frames: [] }),
    });
    expect(r).toBeNull();
  });

  it("carries provenance fields onto the config", () => {
    const r = defaultShortConfig(story, {
      id: "render-X",
      narration_style: "punchy",
      length_preset: "extended",
      props: JSON.stringify({
        doodle_frames: [
          { id: "frame-00", url: "https://gcs/00.png", caption_chunk_start_index: 0 },
        ],
        captions: [{ start_ms: 0, end_ms: 1000, text: "hi" }],
        character_base_url: "https://gcs/base.png",
        voiceover_url: "https://gcs/voice.mp3",
        duration_ms: 45000,
        script: "Once upon a time…",
      }),
    });
    expect(r).not.toBeNull();
    expect(r!.source_render_id).toBe("render-X");
    expect(r!.narration_style).toBe("punchy");
    expect(r!.length_preset).toBe("extended");
    expect(r!.character_base_url).toBe("https://gcs/base.png");
    expect(r!.voiceover_url).toBe("https://gcs/voice.mp3");
    expect(r!.duration_ms).toBe(45000);
    expect(r!.script).toBe("Once upon a time…");
    expect(r!.doodle_frames).toHaveLength(1);
    expect(r!.captions).toHaveLength(1);
  });

  it("accepts the legacy character_image field name", () => {
    const r = defaultShortConfig(story, {
      id: "r-legacy",
      narration_style: null,
      length_preset: null,
      props: JSON.stringify({
        doodle_frames: [
          { id: "f", url: "https://gcs/f.png", caption_chunk_start_index: 0 },
        ],
        character_image: "https://gcs/legacy-base.png",
      }),
    });
    expect(r!.character_base_url).toBe("https://gcs/legacy-base.png");
  });
});

describe("applyShortConfigPatch", () => {
  it("patches a frame's image_prompt by id", () => {
    const next = applyShortConfigPatch(baseConfig(), {
      "doodle_frames.frame-01.image_prompt": "new prompt",
    });
    expect(next.doodle_frames[1].image_prompt).toBe("new prompt");
    // Other frames untouched.
    expect(next.doodle_frames[0].image_prompt).toBeUndefined();
  });

  it("patches a frame's alt and is_pinned by id", () => {
    const next = applyShortConfigPatch(baseConfig(), {
      "doodle_frames.frame-00.alt": "hello",
      "doodle_frames.frame-00.is_pinned": true,
    });
    expect(next.doodle_frames[0].alt).toBe("hello");
    expect(next.doodle_frames[0].is_pinned).toBe(true);
  });

  it("ignores patches for unknown frame ids without throwing", () => {
    const next = applyShortConfigPatch(baseConfig(), {
      "doodle_frames.does-not-exist.image_prompt": "ignored",
    });
    expect(next.doodle_frames).toEqual(baseConfig().doodle_frames);
  });

  it("ignores patches with wrong value types", () => {
    const next = applyShortConfigPatch(baseConfig(), {
      "doodle_frames.frame-00.is_pinned": "true", // string, not bool
    });
    expect(next.doodle_frames[0].is_pinned).toBeUndefined();
  });

  it("patches top-level script + voice; null clears voice", () => {
    const withVoice = applyShortConfigPatch(baseConfig(), {
      script: "Hello",
      voice: { provider: "elevenlabs", voice_id: "v123" },
    });
    expect(withVoice.script).toBe("Hello");
    expect(withVoice.voice).toEqual({
      provider: "elevenlabs",
      voice_id: "v123",
    });
    const cleared = applyShortConfigPatch(withVoice, { voice: null });
    expect(cleared.voice).toBeUndefined();
  });

  it("returns a NEW config (immutability)", () => {
    const base = baseConfig();
    const baseFrameRef = base.doodle_frames[0];
    const next = applyShortConfigPatch(base, {
      "doodle_frames.frame-00.alt": "x",
    });
    expect(next).not.toBe(base);
    expect(next.doodle_frames).not.toBe(base.doodle_frames);
    // Original frame object untouched.
    expect(baseFrameRef.alt).toBeUndefined();
  });

  it("silently drops unsupported paths", () => {
    const next = applyShortConfigPatch(baseConfig(), {
      "captions.0.text": "ignored in phase 1",
      arbitrary_path: 123,
    });
    expect(next.captions).toEqual(baseConfig().captions);
  });
});
