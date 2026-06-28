// Pure-helper tests for lib/duration.ts. The DB-backed paths that consume
// these helpers (homepage-data, short-render-queue, the backfill route)
// have their own integration tests; this file locks down the parsing
// contract in isolation so a malformed input never throws into the
// reader paths.

import { describe, expect, it } from "vitest";
import {
  assembledDurationMsFromPropsJson,
  bodyDurationMsFromPropsJson,
  formatDurationMs,
  fullDurationMsFromParts,
  parseLastRenderedSegments,
  shortDurationFromPropsJson,
} from "@/lib/duration";

describe("formatDurationMs", () => {
  it("formats sub-minute values as 0:SS", () => {
    expect(formatDurationMs(28_400)).toBe("0:28");
    expect(formatDurationMs(1_000)).toBe("0:01");
  });

  it("formats multi-minute values as M:SS", () => {
    expect(formatDurationMs(75_000)).toBe("1:15");
    expect(formatDurationMs(125_000)).toBe("2:05");
  });

  it("rounds the seconds half-up to the nearest integer", () => {
    expect(formatDurationMs(28_499)).toBe("0:28");
    expect(formatDurationMs(28_500)).toBe("0:29");
  });

  it("rounds 59.6s to 1:00 rather than emitting 0:60", () => {
    expect(formatDurationMs(59_600)).toBe("1:00");
  });

  it("returns null for null, undefined, NaN, infinite, zero, and negative inputs", () => {
    expect(formatDurationMs(null)).toBeNull();
    expect(formatDurationMs(undefined)).toBeNull();
    expect(formatDurationMs(Number.NaN)).toBeNull();
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatDurationMs(0)).toBeNull();
    expect(formatDurationMs(-1)).toBeNull();
  });
});

describe("shortDurationFromPropsJson", () => {
  it("extracts duration_ms and formats it as M:SS", () => {
    expect(shortDurationFromPropsJson(JSON.stringify({ duration_ms: 47_000 })))
      .toBe("0:47");
  });

  it("returns null for null / empty / unparseable / missing input", () => {
    expect(shortDurationFromPropsJson(null)).toBeNull();
    expect(shortDurationFromPropsJson("")).toBeNull();
    expect(shortDurationFromPropsJson("{not json")).toBeNull();
    expect(shortDurationFromPropsJson(JSON.stringify({ other: 1 }))).toBeNull();
  });
});

describe("bodyDurationMsFromPropsJson", () => {
  it("returns the raw ms when duration_ms is a positive number", () => {
    expect(bodyDurationMsFromPropsJson(JSON.stringify({ duration_ms: 42_000 })))
      .toBe(42_000);
  });

  it("returns null when duration_ms is zero, negative, or non-numeric", () => {
    expect(bodyDurationMsFromPropsJson(JSON.stringify({ duration_ms: 0 })))
      .toBeNull();
    expect(bodyDurationMsFromPropsJson(JSON.stringify({ duration_ms: -1 })))
      .toBeNull();
    expect(
      bodyDurationMsFromPropsJson(JSON.stringify({ duration_ms: "fortyTwo" })),
    ).toBeNull();
  });

  it("returns null for null / empty / unparseable input", () => {
    expect(bodyDurationMsFromPropsJson(null)).toBeNull();
    expect(bodyDurationMsFromPropsJson("")).toBeNull();
    expect(bodyDurationMsFromPropsJson("{not json")).toBeNull();
  });
});

describe("assembledDurationMsFromPropsJson", () => {
  it("returns the raw ms when assembled_duration_ms is a positive number", () => {
    // _plans/2026-06-29-actual-mp4-duration.md — the ffprobed length of
    // the spliced MP4. Reader paths prefer this over the body+intro+
    // outro sum because it reflects actual playback length.
    expect(
      assembledDurationMsFromPropsJson(
        JSON.stringify({ assembled_duration_ms: 44_321 }),
      ),
    ).toBe(44_321);
  });

  it("returns null when assembled_duration_ms is missing", () => {
    // Older renders (pre-_plans/2026-06-29) didn't carry the field; the
    // reader must fall through cleanly to the legacy sum path.
    expect(
      assembledDurationMsFromPropsJson(JSON.stringify({ duration_ms: 35_000 })),
    ).toBeNull();
  });

  it("returns null for zero, negative, non-numeric, or non-finite values", () => {
    expect(
      assembledDurationMsFromPropsJson(
        JSON.stringify({ assembled_duration_ms: 0 }),
      ),
    ).toBeNull();
    expect(
      assembledDurationMsFromPropsJson(
        JSON.stringify({ assembled_duration_ms: -1 }),
      ),
    ).toBeNull();
    expect(
      assembledDurationMsFromPropsJson(
        JSON.stringify({ assembled_duration_ms: "44s" }),
      ),
    ).toBeNull();
    expect(
      assembledDurationMsFromPropsJson(
        JSON.stringify({ assembled_duration_ms: null }),
      ),
    ).toBeNull();
  });

  it("returns null for null / empty / unparseable input", () => {
    expect(assembledDurationMsFromPropsJson(null)).toBeNull();
    expect(assembledDurationMsFromPropsJson(undefined)).toBeNull();
    expect(assembledDurationMsFromPropsJson("")).toBeNull();
    expect(assembledDurationMsFromPropsJson("{not json")).toBeNull();
  });
});

describe("fullDurationMsFromParts", () => {
  it("sums body + intro + outro when all three are positive", () => {
    expect(fullDurationMsFromParts(42_000, 4_000, 3_000)).toBe(49_000);
  });

  it("treats null / undefined / NaN / non-positive as zero", () => {
    expect(fullDurationMsFromParts(42_000, null, undefined)).toBe(42_000);
    expect(fullDurationMsFromParts(42_000, Number.NaN, 0)).toBe(42_000);
    expect(fullDurationMsFromParts(42_000, -100, "5_000" as unknown as number))
      .toBe(42_000);
  });
});

describe("parseLastRenderedSegments", () => {
  it("returns the intro + outro ids when both are present", () => {
    const cfg = JSON.stringify({
      _last_rendered_segments: {
        intro_segment_id: "intro-a",
        outro_segment_id: "outro-a",
      },
    });
    expect(parseLastRenderedSegments(cfg)).toEqual({
      intro_segment_id: "intro-a",
      outro_segment_id: "outro-a",
    });
  });

  it("handles a one-sided stamp (intro only)", () => {
    const cfg = JSON.stringify({
      _last_rendered_segments: {
        intro_segment_id: "intro-a",
        outro_segment_id: null,
      },
    });
    expect(parseLastRenderedSegments(cfg)).toEqual({
      intro_segment_id: "intro-a",
      outro_segment_id: null,
    });
  });

  it("returns null when both sides are missing or non-strings", () => {
    expect(
      parseLastRenderedSegments(
        JSON.stringify({ _last_rendered_segments: {} }),
      ),
    ).toBeNull();
    expect(
      parseLastRenderedSegments(
        JSON.stringify({
          _last_rendered_segments: {
            intro_segment_id: 5,
            outro_segment_id: true,
          },
        }),
      ),
    ).toBeNull();
  });

  it("returns null for null / empty / unparseable / wrong-shape input", () => {
    expect(parseLastRenderedSegments(null)).toBeNull();
    expect(parseLastRenderedSegments("")).toBeNull();
    expect(parseLastRenderedSegments("{not json")).toBeNull();
    expect(parseLastRenderedSegments(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseLastRenderedSegments(JSON.stringify({ other: "field" })))
      .toBeNull();
  });
});
