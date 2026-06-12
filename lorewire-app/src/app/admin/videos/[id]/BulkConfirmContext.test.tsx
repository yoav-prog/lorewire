// @vitest-environment happy-dom

// Tests for the bulk-confirm decision logic (Phase 4 of the video
// editor overhaul). The React provider is tested by integration when
// the editor runs; this file pins the pure decision function so any
// future tuning of window / threshold / trust duration ships with
// the contract visible.

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import {
  BURST_THRESHOLD,
  BURST_WINDOW_MS,
  BulkConfirmProvider,
  shouldDeferToBurst,
} from "./BulkConfirmContext";

describe("shouldDeferToBurst", () => {
  it("fires immediately on the first click", () => {
    const r = shouldDeferToBurst({
      history: [],
      now: 1000,
      confirmedUntil: 0,
    });
    expect(r.defer).toBe(false);
    expect(r.nextHistory).toEqual([1000]);
  });

  it("fires immediately on the second click", () => {
    const r = shouldDeferToBurst({
      history: [1000],
      now: 1500,
      confirmedUntil: 0,
    });
    expect(r.defer).toBe(false);
    expect(r.nextHistory).toEqual([1000, 1500]);
  });

  it("defers on the third click inside the window", () => {
    const r = shouldDeferToBurst({
      history: [1000, 1500],
      now: 2000,
      confirmedUntil: 0,
    });
    expect(r.defer).toBe(true);
    expect(r.nextHistory).toEqual([1000, 1500, 2000]);
  });

  it("does NOT defer when older clicks have aged out of the window", () => {
    // Two old clicks (t=1000, t=1500), third at t=1500 + window + 100.
    // Both old clicks age out (6600 - 1000 = 5600, 6600 - 1500 = 5100,
    // both > 5000ms window). Only the new click counts. Length 1,
    // below threshold.
    const now = 1500 + BURST_WINDOW_MS + 100;
    const r = shouldDeferToBurst({
      history: [1000, 1500],
      now,
      confirmedUntil: 0,
    });
    expect(r.defer).toBe(false);
    expect(r.nextHistory).toEqual([now]);
  });

  it("does NOT defer when within the trusted-confirm window", () => {
    // 3+ clicks but confirmedUntil is still in the future.
    const r = shouldDeferToBurst({
      history: [1000, 1500, 2000],
      now: 2500,
      confirmedUntil: 5000,
    });
    expect(r.defer).toBe(false);
  });

  it("respects custom threshold + window via opts", () => {
    const r1 = shouldDeferToBurst({
      history: [1000],
      now: 1500,
      confirmedUntil: 0,
      burstThreshold: 2,
    });
    expect(r1.defer).toBe(true);

    const r2 = shouldDeferToBurst({
      history: [1000, 1500],
      now: 1600,
      confirmedUntil: 0,
      burstWindowMs: 50,
    });
    // 1600 - 1000 = 600 > 50 so 1000 ages out. 1600 - 1500 = 100 > 50
    // so 1500 also ages out. Only [1600] left — below threshold.
    expect(r2.defer).toBe(false);
    expect(r2.nextHistory).toEqual([1600]);
  });

  it("prunes timestamps older than the window even when deferring", () => {
    const r = shouldDeferToBurst({
      history: [0, 100, 4500],
      now: 5500, // 5500 - 0 = 5500 > 5000, 5500 - 100 = 5400 > 5000
      confirmedUntil: 0,
    });
    // 0 and 100 age out; 4500 and 5500 remain. Below threshold of 3.
    expect(r.defer).toBe(false);
    expect(r.nextHistory).toEqual([4500, 5500]);
  });

  it("exports a sensible default threshold (matches the plan's `bulk_confirm_threshold = 3`)", () => {
    expect(BURST_THRESHOLD).toBe(3);
  });
});

describe("BulkConfirmProvider", () => {
  it("renders its children when no burst is in flight", () => {
    const html = renderToString(
      <BulkConfirmProvider defaultEstimateCents={5}>
        <span data-test-child="yes">hello</span>
      </BulkConfirmProvider>,
    );
    expect(html).toContain('data-test-child="yes"');
    expect(html).toContain("hello");
    // No modal on initial render.
    expect(html).not.toContain("Confirm bulk regen");
  });
});
