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

  it("scales font sizes and outline widths with the width axis", () => {
    const s = computeScale(1920, 1080);
    // The composition's chunk-base font sizes are 96 / 80 / 64 — at 16:9
    // they should grow to keep the same visual proportion of the canvas.
    expect(s.scaleW(96)).toBeCloseTo(96 * (1920 / 1080), 4);
    expect(s.scaleW(80)).toBeCloseTo(80 * (1920 / 1080), 4);
    expect(s.scaleW(64)).toBeCloseTo(64 * (1920 / 1080), 4);
    // Outline width 6 stays the same ratio.
    expect(s.scaleW(6)).toBeCloseTo(6 * (1920 / 1080), 4);
  });

  it("survives off-baseline canvas sizes gracefully", () => {
    // 2160 wide would be a 4K version of 16:9. The formula keeps working.
    const s = computeScale(2160, 1215);
    expect(s.ratioW).toBeCloseTo(2160 / 1080, 6);
    expect(s.scaleW(10)).toBeCloseTo(20, 4);
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
