// Unit tests for the shared title length policy. These pin the boundary the
// generator mirror (title-regenerator), the Content "too long" filter (repo),
// and the bulk fix (actions) all read, so a change to the cap can't silently
// disagree between the three. Plan:
// _plans/2026-07-15-too-long-title-filter-and-bulk-fix.md.

import { describe, expect, it } from "vitest";
import {
  TITLE_MAX_CHARS,
  TITLE_MAX_WORDS,
  isTitleTooLong,
  titleWordCount,
} from "@/lib/title-policy";

describe("title-policy caps", () => {
  it("pins the single cap the generator + filter + fix share", () => {
    expect(TITLE_MAX_CHARS).toBe(50);
    expect(TITLE_MAX_WORDS).toBe(8);
  });
});

describe("titleWordCount", () => {
  it("counts words, collapsing whitespace runs and ignoring blank ends", () => {
    expect(titleWordCount("THE $800 ENVELOPE")).toBe(3);
    expect(titleWordCount("  padded   spaces  here ")).toBe(3);
    expect(titleWordCount("")).toBe(0);
    expect(titleWordCount("   ")).toBe(0);
  });
});

describe("isTitleTooLong", () => {
  it("treats null / blank as NOT too long (a missing title is a different problem)", () => {
    expect(isTitleTooLong(null)).toBe(false);
    expect(isTitleTooLong(undefined)).toBe(false);
    expect(isTitleTooLong("")).toBe(false);
    expect(isTitleTooLong("   ")).toBe(false);
  });

  it("accepts a title sitting exactly on each bound", () => {
    // Exactly 8 words (39 chars) — at the word bound, under the char bound.
    expect(isTitleTooLong("ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT")).toBe(false);
    // Exactly 50 chars, 1 word — at the char bound.
    expect(isTitleTooLong("A".repeat(50))).toBe(false);
  });

  it("flags a title one past the word bound", () => {
    expect(isTitleTooLong("ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE")).toBe(
      true,
    );
  });

  it("flags a title one past the char bound", () => {
    expect(isTitleTooLong("A".repeat(51))).toBe(true);
  });

  it("ignores surrounding whitespace when measuring", () => {
    // 50 chars of content with padding — trimmed length is 50, still OK.
    expect(isTitleTooLong(`   ${"A".repeat(50)}   `)).toBe(false);
  });
});
