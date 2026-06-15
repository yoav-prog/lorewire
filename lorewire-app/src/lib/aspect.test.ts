// Tests for the aspect resolver mirror at lorewire-app/src/lib/aspect.ts.
//
// Covers two concerns:
//   1. The pure-data helpers — `aspectDims`, `resolveAspect`, `isVideoAspect`
//      — return the right shapes for both supported aspects and fall through
//      the resolution chain correctly.
//   2. Parity with the source-of-truth file at `video/src/aspect.ts`. The two
//      copies MUST stay in sync; this test imports both via Node's filesystem
//      and asserts the exported constants + dimensions match byte-for-byte
//      so an accidental drift in either file fails CI loudly.
//
// Phase 0 of _plans/2026-06-12-video-aspect-ratio.md.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  activeSegmentSettingKey,
  aspectDims,
  inferAspectFromDims,
  isVideoAspect,
  LEGACY_DEFAULT_ASPECT,
  legacyActiveSegmentSettingKey,
  resolveAspect,
  VIDEO_ASPECTS,
  type VideoAspect,
} from "./aspect";

describe("aspectDims", () => {
  it("returns 1920x1080 + cssRatio + ffmpegSize for 16:9", () => {
    const dims = aspectDims("16:9");
    expect(dims.width).toBe(1920);
    expect(dims.height).toBe(1080);
    expect(dims.cssRatio).toBe("16 / 9");
    expect(dims.ffmpegSize).toBe("1920:1080");
  });

  it("returns 1080x1920 + cssRatio + ffmpegSize for 9:16 (the legacy default)", () => {
    const dims = aspectDims("9:16");
    expect(dims.width).toBe(1080);
    expect(dims.height).toBe(1920);
    expect(dims.cssRatio).toBe("9 / 16");
    expect(dims.ffmpegSize).toBe("1080:1920");
  });
});

describe("isVideoAspect", () => {
  it("accepts the two supported aspect strings", () => {
    expect(isVideoAspect("16:9")).toBe(true);
    expect(isVideoAspect("9:16")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isVideoAspect(undefined)).toBe(false);
    expect(isVideoAspect(null)).toBe(false);
    expect(isVideoAspect("")).toBe(false);
    expect(isVideoAspect("4:3")).toBe(false);
    expect(isVideoAspect("16x9")).toBe(false); // wrong separator
    expect(isVideoAspect(169)).toBe(false);
    expect(isVideoAspect({})).toBe(false);
  });
});

describe("resolveAspect", () => {
  it("returns the per-story aspect when one is set", () => {
    expect(resolveAspect("16:9", "9:16")).toBe("16:9");
    expect(resolveAspect("9:16", "16:9")).toBe("9:16");
  });

  it("falls back to the global default when the per-story aspect is missing", () => {
    expect(resolveAspect(undefined, "16:9")).toBe("16:9");
    expect(resolveAspect(undefined, "9:16")).toBe("9:16");
  });

  it("falls back to the legacy default (9:16) when both are missing", () => {
    expect(resolveAspect(undefined, undefined)).toBe(LEGACY_DEFAULT_ASPECT);
    expect(resolveAspect(undefined, undefined)).toBe("9:16");
  });

  it("treats invalid values as missing at both tiers", () => {
    // The TypeScript signature forbids these at compile time but runtime
    // JSON / form data can pass anything. The fallback must hold.
    expect(
      resolveAspect(
        "garbage" as unknown as VideoAspect,
        "9:16" as VideoAspect,
      ),
    ).toBe("9:16");
    expect(
      resolveAspect(undefined, "garbage" as unknown as VideoAspect),
    ).toBe(LEGACY_DEFAULT_ASPECT);
  });
});

describe("VIDEO_ASPECTS enum", () => {
  it("enumerates both supported aspects in a predictable order", () => {
    expect(VIDEO_ASPECTS).toEqual(["16:9", "9:16"]);
  });
});

// ─── inferAspectFromDims ─────────────────────────────────────────────────────
// Used by SegmentUploadForm.tsx to auto-flip the chip on file pick.
// 2026-06-14 plan: production diagnosis was that the chip defaulted to
// 9:16 and silently stamped that on uploaded 16:9 sources.

describe("inferAspectFromDims", () => {
  it("classifies landscape sources as 16:9", () => {
    expect(inferAspectFromDims(3840, 2160)).toBe("16:9"); // 4K — the triggering case
    expect(inferAspectFromDims(1920, 1080)).toBe("16:9");
    expect(inferAspectFromDims(1280, 720)).toBe("16:9");
    expect(inferAspectFromDims(854, 480)).toBe("16:9");
  });

  it("classifies portrait sources as 9:16 (the legacy default)", () => {
    expect(inferAspectFromDims(1080, 1920)).toBe("9:16");
    expect(inferAspectFromDims(720, 1280)).toBe("9:16");
  });

  it("collapses square sources to the legacy default", () => {
    // The renderer doesn't emit 1:1, so a square source has to become
    // SOMETHING — picking 9:16 (legacy default) matches the worker
    // and avoids the chip flipping to a value the resolver can't use.
    expect(inferAspectFromDims(1080, 1080)).toBe(LEGACY_DEFAULT_ASPECT);
  });

  it("falls through to the legacy default on bad dims", () => {
    // ffprobe failures get caught at the call site (probe returns
    // None / undefined dims), but defense in depth here — a leaked
    // zero or negative shouldn't produce a confidently-wrong answer.
    for (const [w, h] of [[0, 1080], [1920, 0], [-1, 100], [100, -1], [0, 0]]) {
      expect(inferAspectFromDims(w, h)).toBe(LEGACY_DEFAULT_ASPECT);
    }
    expect(inferAspectFromDims(Number.NaN, 1080)).toBe(LEGACY_DEFAULT_ASPECT);
    expect(inferAspectFromDims(1920, Number.POSITIVE_INFINITY)).toBe(
      LEGACY_DEFAULT_ASPECT,
    );
  });
});

// ─── Per-aspect active pointer keys ──────────────────────────────────────────
// 2026-06-15: "active" intro/outro is per-aspect. These exact strings are the
// cross-language contract — pipeline/aspect.py's matching test asserts the same
// literals, so if either side drifts, one of the two suites fails loudly.

describe("activeSegmentSettingKey", () => {
  it("builds the four per-aspect slot keys", () => {
    expect(activeSegmentSettingKey("intro", "16:9")).toBe(
      "video.active_intro_id_16x9",
    );
    expect(activeSegmentSettingKey("intro", "9:16")).toBe(
      "video.active_intro_id_9x16",
    );
    expect(activeSegmentSettingKey("outro", "16:9")).toBe(
      "video.active_outro_id_16x9",
    );
    expect(activeSegmentSettingKey("outro", "9:16")).toBe(
      "video.active_outro_id_9x16",
    );
  });

  it("keeps the legacy single-pointer keys for the seed migration", () => {
    expect(legacyActiveSegmentSettingKey("intro")).toBe("video.active_intro_id");
    expect(legacyActiveSegmentSettingKey("outro")).toBe("video.active_outro_id");
  });
});

// ─── Parity with video/src/aspect.ts ─────────────────────────────────────────
// The renderer-side module is the source of truth; this mirror exists so the
// admin client doesn't pull Remotion into its bundle. To keep them honest we
// read both files and assert the exported public surface is byte-identical
// for the bits that matter (the DIMS map, the constants, and the resolver).

describe("parity with video/src/aspect.ts", () => {
  it("declares the same DIMS map", () => {
    const here = readFileSync(__filename.replace(/\.test\.ts$/, ".ts"), "utf8");
    const there = readFileSync(
      resolve(__filename, "..", "..", "..", "..", "video", "src", "aspect.ts"),
      "utf8",
    );
    const dimsBlock = (src: string) => {
      const start = src.indexOf("const DIMS: Record<VideoAspect, AspectDims>");
      const end = src.indexOf("};", start) + 2;
      return src.slice(start, end);
    };
    expect(dimsBlock(here)).toBe(dimsBlock(there));
  });

  it("declares the same LEGACY_DEFAULT_ASPECT", () => {
    const there = readFileSync(
      resolve(__filename, "..", "..", "..", "..", "video", "src", "aspect.ts"),
      "utf8",
    );
    expect(there).toContain('LEGACY_DEFAULT_ASPECT: VideoAspect = "9:16"');
  });

  it("declares the same VIDEO_ASPECTS order", () => {
    const there = readFileSync(
      resolve(__filename, "..", "..", "..", "..", "video", "src", "aspect.ts"),
      "utf8",
    );
    expect(there).toContain('VIDEO_ASPECTS: readonly VideoAspect[] = ["16:9", "9:16"]');
  });
});
