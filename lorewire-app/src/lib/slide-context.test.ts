// @vitest-environment happy-dom

// Pure-helper tests for lib/slide-context.ts — the decision logic behind
// the prev/next slide controls on the detail surfaces (mobile TitleSheet,
// desktop DetailModal). The DOM wiring (chevrons, touch handlers, keydown)
// lives in the shells and delegates every decision to these helpers, so
// locking the contract here covers wrap-around, hidden-control, and
// gesture-classification behavior for both shells at once.
// Plan: _plans/2026-07-04-slide-between-row-stories.md.

import { describe, expect, it } from "vitest";
import {
  SLIDE_SWIPE_THRESHOLD_PX,
  isSlideKeyExempt,
  isSlideSwipeExempt,
  resolveSwipeDirection,
  slidePosition,
  slideTarget,
  type SlideContext,
} from "@/lib/slide-context";

const ROW: SlideContext = {
  ids: ["a", "b", "c", "d"],
  label: "Top 10 Today",
};

describe("slidePosition", () => {
  it("locates the current story inside the context", () => {
    expect(slidePosition(ROW, "a")).toEqual({ index: 0, total: 4 });
    expect(slidePosition(ROW, "c")).toEqual({ index: 2, total: 4 });
  });

  it("returns null when the id is not in the snapshot", () => {
    // e.g. the context came from More Like This and the user kept
    // drilling into stories outside the original row.
    expect(slidePosition(ROW, "zz")).toBeNull();
  });

  it("returns null for a missing context (deep-link open)", () => {
    expect(slidePosition(null, "a")).toBeNull();
    expect(slidePosition(undefined, "a")).toBeNull();
  });

  it("returns null for lists with fewer than two stories", () => {
    expect(slidePosition({ ids: [], label: "Saved" }, "a")).toBeNull();
    expect(slidePosition({ ids: ["a"], label: "Saved" }, "a")).toBeNull();
  });
});

describe("slideTarget", () => {
  it("moves one step in either direction from the middle", () => {
    expect(slideTarget(ROW, "b", 1)).toBe("c");
    expect(slideTarget(ROW, "b", -1)).toBe("a");
  });

  it("wraps forward from the last story to the first", () => {
    expect(slideTarget(ROW, "d", 1)).toBe("a");
  });

  it("wraps backward from the first story to the last", () => {
    // Explicit product requirement: on story 1, sliding back lands on
    // story N ("slide left to number 10").
    expect(slideTarget(ROW, "a", -1)).toBe("d");
  });

  it("returns null whenever the position is null", () => {
    expect(slideTarget(ROW, "zz", 1)).toBeNull();
    expect(slideTarget(null, "a", 1)).toBeNull();
    expect(slideTarget({ ids: ["a"], label: "Saved" }, "a", 1)).toBeNull();
  });

  it("round-trips: next then previous returns to the start", () => {
    for (const id of ROW.ids) {
      const next = slideTarget(ROW, id, 1)!;
      expect(slideTarget(ROW, next, -1)).toBe(id);
    }
  });
});

describe("resolveSwipeDirection", () => {
  it("maps a long left swipe to next (1) and right swipe to previous (-1)", () => {
    expect(resolveSwipeDirection(-120, 4)).toBe(1);
    expect(resolveSwipeDirection(120, -4)).toBe(-1);
  });

  it("ignores taps and short flicks under the threshold", () => {
    expect(resolveSwipeDirection(0, 0)).toBeNull();
    expect(resolveSwipeDirection(SLIDE_SWIPE_THRESHOLD_PX - 1, 0)).toBeNull();
    expect(resolveSwipeDirection(-(SLIDE_SWIPE_THRESHOLD_PX - 1), 0)).toBeNull();
  });

  it("accepts exactly the threshold", () => {
    expect(resolveSwipeDirection(-SLIDE_SWIPE_THRESHOLD_PX, 0)).toBe(1);
  });

  it("ignores vertical and diagonal gestures (scroll attempts)", () => {
    expect(resolveSwipeDirection(0, 200)).toBeNull();
    expect(resolveSwipeDirection(-80, 90)).toBeNull();
  });

  it("allows a mostly-horizontal gesture with some vertical drift", () => {
    expect(resolveSwipeDirection(-100, 40)).toBe(1);
  });
});

describe("isSlideSwipeExempt", () => {
  it("exempts touches starting on the video player and text inputs", () => {
    const root = document.createElement("div");
    for (const tag of ["video", "input", "textarea"]) {
      const el = document.createElement(tag);
      root.appendChild(el);
      expect(isSlideSwipeExempt(el, root)).toBe(true);
    }
  });

  it("exempts descendants of an exempt element (a button inside a video overlay)", () => {
    const root = document.createElement("div");
    const video = document.createElement("video");
    const overlay = document.createElement("button");
    video.appendChild(overlay);
    root.appendChild(video);
    expect(isSlideSwipeExempt(overlay, root)).toBe(true);
  });

  it("does not exempt plain content, and stops walking at the boundary", () => {
    // The boundary root itself scrolls vertically and must never make
    // its own descendants exempt — the walk excludes `boundary`.
    const root = document.createElement("div");
    const p = document.createElement("p");
    root.appendChild(p);
    expect(isSlideSwipeExempt(p, root)).toBe(false);
    expect(isSlideSwipeExempt(null, root)).toBe(false);
  });
});

describe("isSlideKeyExempt", () => {
  it("exempts form fields and the video player", () => {
    for (const tag of ["input", "textarea", "select", "video"]) {
      expect(isSlideKeyExempt(document.createElement(tag))).toBe(true);
    }
  });

  it("does not exempt ordinary elements or non-element targets", () => {
    expect(isSlideKeyExempt(document.createElement("div"))).toBe(false);
    expect(isSlideKeyExempt(document.createElement("button"))).toBe(false);
    expect(isSlideKeyExempt(null)).toBe(false);
  });
});
