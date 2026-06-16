// Tests for the TS read-side of the hero style registry.
//
// Phase 2 step 2 of _plans/2026-06-17-hero-style-registry.md. The
// Python parity test (`pipeline/tests/test_hero_styles_sync.py`)
// guards drift between Python source-of-truth and the committed JSON.
// What we cover here is the TS façade on top of that JSON: closed-enum
// validation + caption rendering for each resolution source. These are
// the helpers the picker UI in step 4 calls.

import { describe, expect, it } from "vitest";
import {
  CATEGORY_STYLE_WHITELIST,
  HERO_STYLES,
  HERO_STYLES_BY_ID,
  heroStyleSourceLabel,
  isHeroStyleId,
} from "./hero-styles";

describe("HERO_STYLES", () => {
  it("ships exactly 6 styles at MVP", () => {
    // Plan locks 6 styles. Adding a 7th is a deliberate plan bump; this
    // test catches an accidental addition that slipped through review.
    expect(HERO_STYLES.length).toBe(6);
  });

  it("every style has the expected shape", () => {
    for (const style of HERO_STYLES) {
      expect(typeof style.id).toBe("string");
      expect(style.id.length).toBeGreaterThan(0);
      expect(typeof style.label).toBe("string");
      expect(style.label.length).toBeGreaterThan(0);
      // thumbnail_url is null until step 3 generates the previews; the
      // picker handles the null case with a placeholder.
      expect(style.thumbnail_url === null || typeof style.thumbnail_url === "string").toBe(true);
    }
  });

  it("HERO_STYLES_BY_ID covers every style in HERO_STYLES", () => {
    expect(Object.keys(HERO_STYLES_BY_ID).length).toBe(HERO_STYLES.length);
    for (const style of HERO_STYLES) {
      expect(HERO_STYLES_BY_ID[style.id]).toBe(style);
    }
  });
});

describe("CATEGORY_STYLE_WHITELIST", () => {
  it("has an entry for every category the app uses", () => {
    for (const cat of ["Entitled", "Drama", "Humor", "Wholesome", "Dating", "Roommate"]) {
      expect(CATEGORY_STYLE_WHITELIST[cat]).toBeDefined();
      expect(CATEGORY_STYLE_WHITELIST[cat].length).toBeGreaterThanOrEqual(2);
    }
  });

  it("every whitelist id exists in HERO_STYLES_BY_ID", () => {
    // Typo guard: a stale id in the whitelist would break the
    // auto-pick caption "Auto-picked from [magazine_editorial, ...]"
    // because the picker can't look up the label. Catches Python-side
    // edits that didn't re-sync the JSON.
    for (const [category, ids] of Object.entries(CATEGORY_STYLE_WHITELIST)) {
      for (const id of ids) {
        expect(HERO_STYLES_BY_ID[id]).toBeDefined();
        expect(
          HERO_STYLES_BY_ID[id],
          `category ${category} whitelist references unknown style ${id}`,
        ).toBeTruthy();
      }
    }
  });
});

describe("isHeroStyleId", () => {
  it("accepts known ids", () => {
    for (const style of HERO_STYLES) {
      expect(isHeroStyleId(style.id)).toBe(true);
    }
  });

  it("rejects unknown / empty / nullish input", () => {
    // Closed-enum check used by server actions to validate picker
    // input. A bogus id reaching `stories.hero_style_id` would silently
    // produce no-style prompts downstream.
    expect(isHeroStyleId(null)).toBe(false);
    expect(isHeroStyleId(undefined)).toBe(false);
    expect(isHeroStyleId("")).toBe(false);
    expect(isHeroStyleId("not_a_real_style")).toBe(false);
    expect(isHeroStyleId("MAGAZINE_EDITORIAL")).toBe(false); // case-sensitive
  });
});

describe("heroStyleSourceLabel", () => {
  it("labels per-story pins cleanly", () => {
    expect(heroStyleSourceLabel("per_story", "Drama")).toBe("Pinned for this story");
  });

  it("category default mentions the category name", () => {
    expect(heroStyleSourceLabel("category_default", "Entitled")).toContain("Entitled");
  });

  it("global default doesn't surface category context", () => {
    // Global default is intentionally category-agnostic — the caption
    // shouldn't claim it's tied to the current category.
    const out = heroStyleSourceLabel("global_default", "Entitled");
    expect(out).toBe("Inherited from the global default");
    expect(out).not.toContain("Entitled");
  });

  it("auto-hash lists the whitelist that produced the pick", () => {
    const whitelist = ["magazine_editorial", "retro_pulp", "comic_book"];
    const out = heroStyleSourceLabel("auto_hash", "Entitled", whitelist);
    expect(out).toContain("Entitled");
    for (const id of whitelist) {
      expect(out).toContain(id);
    }
  });

  it("auto-hash gracefully handles a missing whitelist", () => {
    // Defensive: if step 5 ever passes an empty whitelist by mistake,
    // the caption still reads OK instead of saying "from the … ()".
    const out = heroStyleSourceLabel("auto_hash", "Drama");
    expect(out).toContain("Drama");
    expect(out).not.toContain("()");
  });
});
