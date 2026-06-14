// Tests for the composition-scale mirror at lorewire-app/src/lib/composition-scale.ts.
//
// Phase 1 of _plans/2026-06-12-video-aspect-ratio.md. Covers two concerns:
//   1. `computeScale` returns identity ratios for the legacy portrait
//      canvas so existing renders are byte-identical, and the right
//      proportional ratios for landscape.
//   2. The renderer-side mirror at `video/src/scale.ts` carries the same
//      BASE_WIDTH / BASE_HEIGHT constants + the same scale math. Parity
//      is enforced by reading both files and pinning the relevant
//      declarations.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  BASE_HEIGHT,
  BASE_WIDTH,
  computeScale,
} from "./composition-scale";

describe("computeScale", () => {
  it("returns identity ratios for the legacy 1080x1920 portrait canvas", () => {
    const s = computeScale(BASE_WIDTH, BASE_HEIGHT);
    expect(s.ratioW).toBe(1);
    expect(s.ratioH).toBe(1);
    expect(s.scaleW(96)).toBe(96);
    expect(s.scaleH(96)).toBe(96);
    expect(s.scaleW(0)).toBe(0);
  });

  it("scales width-axis values up for landscape (16:9 = 1920 wide)", () => {
    const s = computeScale(1920, 1080);
    expect(s.ratioW).toBeCloseTo(1920 / 1080, 6);
    // padding_x of 64 should grow proportionally to the wider canvas
    expect(s.scaleW(64)).toBeCloseTo(64 * (1920 / 1080), 4);
  });

  it("scales height-axis values down for landscape (16:9 = 1080 tall)", () => {
    const s = computeScale(1920, 1080);
    expect(s.ratioH).toBeCloseTo(1080 / 1920, 6);
    // A title chip pinned at top:96 should sit relatively closer to the
    // top edge on a shorter canvas.
    expect(s.scaleH(96)).toBeCloseTo(96 * (1080 / 1920), 4);
  });

  it("scales horizontal padding and max-width values with the width axis", () => {
    // scaleW is the multiplier for true horizontal-axis values: the
    // caption band's outer paddingX, the title chip's maxWidth, the
    // channel pill's left/right padding. Those should grow with the
    // wider landscape canvas so the layout breathes the same way.
    const s = computeScale(1920, 1080);
    expect(s.scaleW(64)).toBeCloseTo(64 * (1920 / 1080), 4);
    expect(s.scaleW(28)).toBeCloseTo(28 * (1920 / 1080), 4);
  });

  it("sizes captions with scaleMin so landscape doesn't blow them up", () => {
    // The caption fontSize / outlineWidth / shadowOffset / word-gap
    // intentionally use scaleMin (not scaleW). On landscape (1920x1080)
    // scaleW(96) = 171 px, which is 16% of the 1080-tall frame — that's
    // the bug that caused 4-word chunks like "BY FRIDAY THE OFFICE" to
    // wrap onto two lines and dominate the frame. scaleMin tracks the
    // shorter axis so a 96-px portrait caption (5% of the 1920-tall
    // frame) lands at 54 px on landscape (5% of the 1080-tall frame),
    // preserving the visual proportion the type was authored against.
    const landscape = computeScale(1920, 1080);
    expect(landscape.scaleMin(96)).toBeCloseTo(96 * (1080 / 1920), 4);
    expect(landscape.scaleMin(80)).toBeCloseTo(80 * (1080 / 1920), 4);
    expect(landscape.scaleMin(64)).toBeCloseTo(64 * (1080 / 1920), 4);
    // Outline + shadow + word-gap track the same axis so they stay
    // proportional to the font instead of growing past the type.
    expect(landscape.scaleMin(6)).toBeCloseTo(6 * (1080 / 1920), 4);
    expect(landscape.scaleMin(4)).toBeCloseTo(4 * (1080 / 1920), 4);
    expect(landscape.scaleMin(16)).toBeCloseTo(16 * (1080 / 1920), 4);
    // Portrait is identity so existing renders are byte-identical.
    const portrait = computeScale(BASE_WIDTH, BASE_HEIGHT);
    expect(portrait.scaleMin(96)).toBe(96);
    expect(portrait.scaleMin(6)).toBe(6);
  });

  it("survives off-baseline canvas sizes gracefully", () => {
    // 2160 wide would be a 4K version of 16:9. The formula keeps working.
    const s = computeScale(2160, 1215);
    expect(s.ratioW).toBeCloseTo(2160 / 1080, 6);
    expect(s.scaleW(10)).toBeCloseTo(20, 4);
  });

  it("provides a min-axis ratio for fixed-aspect overlays", () => {
    // QA caveat fix from the rollout's 6th caveat round: square / fixed-
    // aspect overlays (prop card, mouth-swap bust, scribble box) used to
    // balloon on landscape because they were scaled by width alone. The
    // ratioMin / scaleMin pair returns the smaller of (ratioW, ratioH)
    // so a 320x320 card stays under both canvas dimensions.
    // Portrait 1080x1920: ratioMin = min(1, 1) = 1 (identity, no change).
    const portrait = computeScale(BASE_WIDTH, BASE_HEIGHT);
    expect(portrait.ratioMin).toBe(1);
    expect(portrait.scaleMin(320)).toBe(320);
    // Landscape 1920x1080: ratioW = 1.78, ratioH = 0.56 -> ratioMin = 0.56.
    const landscape = computeScale(1920, 1080);
    expect(landscape.ratioMin).toBeCloseTo(1080 / 1920, 6);
    expect(landscape.scaleMin(320)).toBeCloseTo(320 * (1080 / 1920), 4);
  });
});

// ─── Parity with video/src/scale.ts ──────────────────────────────────────────

describe("parity with video/src/scale.ts", () => {
  it("declares the same BASE_WIDTH / BASE_HEIGHT", () => {
    const there = readFileSync(
      resolve(__filename, "..", "..", "..", "..", "video", "src", "scale.ts"),
      "utf8",
    );
    expect(there).toContain("BASE_WIDTH = 1080");
    expect(there).toContain("BASE_HEIGHT = 1920");
  });

  it("declares the same scale formula in computeScale", () => {
    const there = readFileSync(
      resolve(__filename, "..", "..", "..", "..", "video", "src", "scale.ts"),
      "utf8",
    );
    // Pull the body of computeScale from each file and compare the formula
    // lines — accept whitespace differences but pin the math.
    const grabComputeScale = (src: string) => {
      const start = src.indexOf("export function computeScale");
      const end = src.indexOf("\n}", start) + 2;
      return src
        .slice(start, end)
        .replace(/\s+/g, " ")
        .trim();
    };
    const here = readFileSync(__filename.replace(/\.test\.ts$/, ".ts"), "utf8");
    expect(grabComputeScale(here)).toBe(grabComputeScale(there));
  });
});
