// Tests for the `video.preview_segment_fit` setting parser. Pure logic;
// every branch covered. The actual Player render is verified manually
// via the editor preview — Remotion components aren't unit-tested here
// (no harness for OffthreadVideo + Player without a Remotion test bed).

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREVIEW_SEGMENT_FIT,
  parsePreviewSegmentFit,
} from "./preview-segment-fit";

describe("parsePreviewSegmentFit", () => {
  it("returns the default when the setting is unset", () => {
    expect(parsePreviewSegmentFit(null)).toBe(DEFAULT_PREVIEW_SEGMENT_FIT);
    expect(parsePreviewSegmentFit(undefined)).toBe(DEFAULT_PREVIEW_SEGMENT_FIT);
    expect(parsePreviewSegmentFit("")).toBe(DEFAULT_PREVIEW_SEGMENT_FIT);
    expect(parsePreviewSegmentFit("   ")).toBe(DEFAULT_PREVIEW_SEGMENT_FIT);
  });

  it("returns 'contain' for the explicit letterbox value", () => {
    expect(parsePreviewSegmentFit("contain")).toBe("contain");
  });

  it("is case- and whitespace-tolerant on 'contain'", () => {
    // Admins editing the settings table directly could land on either
    // case; either spelling has to round-trip cleanly.
    expect(parsePreviewSegmentFit("CONTAIN")).toBe("contain");
    expect(parsePreviewSegmentFit(" Contain ")).toBe("contain");
  });

  it("returns 'cover' for the explicit cover value", () => {
    expect(parsePreviewSegmentFit("cover")).toBe("cover");
    expect(parsePreviewSegmentFit("COVER")).toBe("cover");
  });

  it("falls through to the default on garbage values", () => {
    // Typo, deprecated value, or a future enum entry the runtime
    // doesn't recognise — never produce an unsupported render mode.
    for (const v of ["fill", "scale-down", "fit", "1", "true", "none"]) {
      expect(parsePreviewSegmentFit(v)).toBe(DEFAULT_PREVIEW_SEGMENT_FIT);
    }
  });

  it("default is 'cover' so unset rows match the pre-toggle behavior", () => {
    expect(DEFAULT_PREVIEW_SEGMENT_FIT).toBe("cover");
  });
});
