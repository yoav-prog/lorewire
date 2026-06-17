// Tests for video/src/composition-metadata.ts — the pure renderer-side
// derivation that translates a ShortVideoConfig into the metadata
// Remotion needs for one render (durationInFrames + width + height).
//
// Lives in lorewire-app/ because that's where vitest is configured; the
// import reaches across into video/src/ which works fine because the
// pure helper deliberately has no Remotion imports.
//
// Phase 1 of _plans/2026-06-12-video-aspect-ratio.md. Phase 0 already
// pins aspect.test.ts; this file pins the end-to-end contract that a
// ShortVideoConfig with `aspect: "16:9"` actually emits a 1920x1080
// canvas (and vice versa for portrait + missing field).

import { describe, expect, it } from "vitest";
import {
  deriveCompositionMetadata,
  FPS,
} from "../../../video/src/composition-metadata";
import type { ShortVideoConfig } from "../../../video/src/types";

function baseConfig(overrides: Partial<ShortVideoConfig> = {}): ShortVideoConfig {
  return {
    voiceover_url: "/v.mp3",
    duration_ms: 10000,
    doodle_frames: [],
    captions: [],
    ...overrides,
  };
}

describe("deriveCompositionMetadata — aspect resolution", () => {
  it("returns 1080x1920 portrait for a config with no aspect field (legacy back-compat)", () => {
    const m = deriveCompositionMetadata(baseConfig());
    expect(m.width).toBe(1080);
    expect(m.height).toBe(1920);
    expect(m.resolvedAspect).toBe("9:16");
  });

  it("returns 1080x1920 portrait for an explicit 9:16 config", () => {
    const m = deriveCompositionMetadata(baseConfig({ aspect: "9:16" }));
    expect(m.width).toBe(1080);
    expect(m.height).toBe(1920);
    expect(m.resolvedAspect).toBe("9:16");
  });

  it("returns 1920x1080 landscape for an explicit 16:9 config", () => {
    const m = deriveCompositionMetadata(baseConfig({ aspect: "16:9" }));
    expect(m.width).toBe(1920);
    expect(m.height).toBe(1080);
    expect(m.resolvedAspect).toBe("16:9");
  });

  it("honors the global default when the per-story aspect is unset", () => {
    const m = deriveCompositionMetadata(baseConfig(), "16:9");
    expect(m.width).toBe(1920);
    expect(m.height).toBe(1080);
    expect(m.resolvedAspect).toBe("16:9");
  });

  it("the per-story aspect wins over the global default", () => {
    const m = deriveCompositionMetadata(
      baseConfig({ aspect: "9:16" }),
      "16:9",
    );
    expect(m.width).toBe(1080);
    expect(m.height).toBe(1920);
    expect(m.resolvedAspect).toBe("9:16");
  });
});

describe("deriveCompositionMetadata — duration math (unchanged from before Phase 0)", () => {
  it("rounds up at 30 fps", () => {
    const m = deriveCompositionMetadata(baseConfig({ duration_ms: 10000 }));
    expect(m.durationInFrames).toBe(300);
    expect(FPS).toBe(30);
  });

  it("honors a clip trim window", () => {
    const m = deriveCompositionMetadata(
      baseConfig({
        duration_ms: 10000,
        clip_start_ms: 2000,
        clip_end_ms: 5000,
      }),
    );
    // 3 seconds of trimmed window = 90 frames
    expect(m.durationInFrames).toBe(90);
  });

  it("clamps non-positive trims to at least 1 frame", () => {
    const m = deriveCompositionMetadata(
      baseConfig({
        duration_ms: 10000,
        clip_start_ms: 5000,
        clip_end_ms: 5000,
      }),
    );
    expect(m.durationInFrames).toBe(1);
  });
});

describe("deriveCompositionMetadata — end_hold_ms post-roll", () => {
  it("adds the hold to the rendered duration (shorts hold the last scene)", () => {
    // 10s narration + 1.5s hold = 11.5s = 345 frames at 30 fps.
    const m = deriveCompositionMetadata(
      baseConfig({ duration_ms: 10000, end_hold_ms: 1500 }),
    );
    expect(m.durationInFrames).toBe(345);
  });

  it("is byte-identical to no hold when the field is absent or zero", () => {
    const base = deriveCompositionMetadata(baseConfig({ duration_ms: 10000 }));
    const zero = deriveCompositionMetadata(
      baseConfig({ duration_ms: 10000, end_hold_ms: 0 }),
    );
    expect(zero.durationInFrames).toBe(base.durationInFrames);
    expect(base.durationInFrames).toBe(300);
  });

  it("adds the hold on top of a trim window, never inside it", () => {
    // 3s trimmed window + 1.5s hold = 4.5s = 135 frames.
    const m = deriveCompositionMetadata(
      baseConfig({
        duration_ms: 10000,
        clip_start_ms: 2000,
        clip_end_ms: 5000,
        end_hold_ms: 1500,
      }),
    );
    expect(m.durationInFrames).toBe(135);
  });

  it("ignores a negative hold (treated as no hold)", () => {
    const m = deriveCompositionMetadata(
      baseConfig({ duration_ms: 10000, end_hold_ms: -500 }),
    );
    expect(m.durationInFrames).toBe(300);
  });
});
