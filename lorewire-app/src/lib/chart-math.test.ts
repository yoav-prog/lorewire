// Tests for the pure chart geometry + formatting helpers behind the
// admin analytics charts. No DB, no React — plain math.
//
// Plan: _plans/2026-07-05-admin-analytics.md.

import { describe, expect, it } from "vitest";
import {
  areaPath,
  formatCompact,
  formatPercent,
  fractions,
  linePath,
  niceStep,
  niceTicks,
  percentChange,
  seriesPoints,
  shortDayLabel,
} from "@/lib/chart-math";

describe("formatCompact", () => {
  it("keeps small numbers verbatim", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(7)).toBe("7");
    expect(formatCompact(999)).toBe("999");
  });

  it("compacts thousands and millions", () => {
    expect(formatCompact(1000)).toBe("1K");
    expect(formatCompact(1234)).toBe("1.2K");
    expect(formatCompact(15_400)).toBe("15.4K");
    expect(formatCompact(150_000)).toBe("150K");
    expect(formatCompact(1_500_000)).toBe("1.5M");
    expect(formatCompact(2_000_000_000)).toBe("2B");
  });

  it("keeps the sign on negatives", () => {
    expect(formatCompact(-1234)).toBe("-1.2K");
    expect(formatCompact(-5)).toBe("-5");
  });

  it("never crashes on bad input", () => {
    expect(formatCompact(Number.NaN)).toBe("0");
    expect(formatCompact(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("formatPercent", () => {
  it("renders fractions as whole percents", () => {
    expect(formatPercent(0.42)).toBe("42%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.333, 1)).toBe("33.3%");
  });

  it("renders null (no baseline) as n/a", () => {
    expect(formatPercent(null)).toBe("n/a");
    expect(formatPercent(Number.NaN)).toBe("n/a");
  });
});

describe("percentChange", () => {
  it("computes signed whole-percent change", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(50, 100)).toBe(-50);
    expect(percentChange(100, 100)).toBe(0);
  });

  it("returns null when there is no baseline", () => {
    expect(percentChange(10, 0)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
    expect(percentChange(Number.NaN, 5)).toBeNull();
  });
});

describe("niceStep / niceTicks", () => {
  it("rounds raw steps up to 1/2/5 magnitudes", () => {
    expect(niceStep(1)).toBe(1);
    expect(niceStep(1.3)).toBe(2);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(30)).toBe(50);
    expect(niceStep(0)).toBe(1);
  });

  it("produces ticks from 0 to at least the max", () => {
    const ticks = niceTicks(87);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(87);
  });

  it("gives a usable scale for empty charts", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(-5)).toEqual([0, 1]);
  });
});

describe("seriesPoints / linePath / areaPath", () => {
  it("spreads points across the width and scales y down from the top", () => {
    const pts = seriesPoints([0, 5, 10], 100, 50, 10);
    expect(pts).toEqual([
      { x: 0, y: 50 },
      { x: 50, y: 25 },
      { x: 100, y: 0 },
    ]);
  });

  it("centers a single point", () => {
    expect(seriesPoints([4], 100, 50, 4)).toEqual([{ x: 50, y: 0 }]);
  });

  it("pins everything to the floor when max is 0", () => {
    const pts = seriesPoints([0, 0], 100, 50, 0);
    expect(pts.every((p) => p.y === 50)).toBe(true);
  });

  it("builds SVG paths and closes the area to the baseline", () => {
    const pts = seriesPoints([0, 10], 100, 50, 10);
    expect(linePath(pts)).toBe("M0 50 L100 0");
    expect(areaPath(pts, 50)).toBe("M0 50 L100 0 L100 50 L0 50 Z");
  });

  it("returns empty paths for empty series", () => {
    expect(seriesPoints([], 100, 50, 10)).toEqual([]);
    expect(linePath([])).toBe("");
    expect(areaPath([], 50)).toBe("");
  });
});

describe("fractions", () => {
  it("normalizes to a sum of 1", () => {
    const f = fractions([1, 3]);
    expect(f).toEqual([0.25, 0.75]);
  });

  it("clamps negatives and returns [] for a zero total", () => {
    expect(fractions([0, 0])).toEqual([]);
    expect(fractions([])).toEqual([]);
    expect(fractions([-5, 5])).toEqual([0, 1]);
  });
});

describe("shortDayLabel", () => {
  it("renders YYYY-MM-DD as 'Mon D'", () => {
    expect(shortDayLabel("2026-07-05")).toBe("Jul 5");
    expect(shortDayLabel("2026-01-31")).toBe("Jan 31");
    expect(shortDayLabel("2026-12-01")).toBe("Dec 1");
  });

  it("passes malformed input through unchanged", () => {
    expect(shortDayLabel("not-a-day")).toBe("not-a-day");
    expect(shortDayLabel("2026-13-01")).toBe("2026-13-01");
  });
});
