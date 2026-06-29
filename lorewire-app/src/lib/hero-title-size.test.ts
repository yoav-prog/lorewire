// Tests for the hero-title font-size floor.
//
// Plan: _plans/2026-06-25-title-length-gate.md (Layer 2).
// The pre-floor hero used a hardcoded 84px (desktop) / 46px (mobile).
// These tests pin the new bucket function so:
//   - well-sized titles render identically to the pre-floor sizes
//   - the cinnamon-roll incident's 99-char title no longer ships at
//     a size that wraps to 9 lines

import { describe, expect, it } from "vitest";
import {
  heroTitleBucket,
  heroTitleFontSizeDesktop,
  heroTitleFontSizeMobile,
} from "@/lib/hero-title-size";

describe("heroTitleBucket", () => {
  it("buckets short brand-voice titles as 'short'", () => {
    // Three of the live TITLE_STYLE_EXAMPLES from the Python pipeline.
    expect(heroTitleBucket("THE $800 ENVELOPE")).toBe("short");
    expect(heroTitleBucket("SHE REPLIED ALL")).toBe("short");
    expect(heroTitleBucket("MY ROOMMATE'S 3AM RULES")).toBe("short");
  });

  it("rolls over to 'medium' past 30 chars", () => {
    expect(heroTitleBucket("X".repeat(30))).toBe("short");
    expect(heroTitleBucket("X".repeat(31))).toBe("medium");
    expect(heroTitleBucket("X".repeat(50))).toBe("medium");
  });

  it("rolls over to 'long' past 50 chars", () => {
    expect(heroTitleBucket("X".repeat(51))).toBe("long");
    expect(heroTitleBucket("X".repeat(80))).toBe("long");
  });

  it("rolls over to 'extra-long' past 80 chars", () => {
    expect(heroTitleBucket("X".repeat(81))).toBe("extra-long");
    expect(
      heroTitleBucket(
        "MY SON ATE THE MIDDLES OUT OF EVERY CINNAMON ROLL BEFORE " +
          "I GOT TO THE TABLE THIS MORNING.",
      ),
    ).toBe("extra-long");
  });

  it("treats empty / null-ish input as 'short' (no crash)", () => {
    expect(heroTitleBucket("")).toBe("short");
    // @ts-expect-error — guarding against runtime nulls slipping past TS
    expect(heroTitleBucket(null)).toBe("short");
  });
});

describe("heroTitleFontSizeDesktop", () => {
  it("matches the pre-floor 84px for short titles", () => {
    // The exact size the hero used to hardcode for every title.
    expect(heroTitleFontSizeDesktop("THE $800 ENVELOPE")).toBe(84);
  });

  it("shrinks for medium / long / extra-long titles", () => {
    expect(heroTitleFontSizeDesktop("X".repeat(40))).toBe(64);
    expect(heroTitleFontSizeDesktop("X".repeat(60))).toBe(48);
    expect(heroTitleFontSizeDesktop("X".repeat(99))).toBe(36);
  });
});

describe("heroTitleFontSizeMobile", () => {
  it("matches the pre-floor 46px for short titles", () => {
    expect(heroTitleFontSizeMobile("THE NEIGHBOR'S FENCE")).toBe(46);
  });

  it("shrinks for medium / long / extra-long titles", () => {
    expect(heroTitleFontSizeMobile("X".repeat(40))).toBe(36);
    expect(heroTitleFontSizeMobile("X".repeat(60))).toBe(28);
    expect(heroTitleFontSizeMobile("X".repeat(99))).toBe(22);
  });
});
