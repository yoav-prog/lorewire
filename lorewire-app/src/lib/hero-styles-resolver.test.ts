// Tests for the TS-side hero style resolver.
//
// Step 5 of _plans/2026-06-17-hero-style-registry.md. Two contracts:
//
//   1. `deterministicStylePick` MUST agree with the Python
//      implementation byte-for-byte. Drift here would make the admin
//      picker show one style while the pipeline actually renders a
//      different one. Parity is locked by a shared fixture: the same
//      inputs are asserted on the Python side
//      (`pipeline/tests/test_hero_styles.py::DeterministicStylePickParityTests`),
//      against the same expected outputs hardcoded below.
//
//   2. `resolveHeroStyleFromContext` walks the same four layers as the
//      Python resolver (per-story → category default → global default
//      → auto-hash) and reports the source label the picker caption
//      relies on.

import { describe, expect, it } from "vitest";
import {
  CATEGORY_STYLE_WHITELIST,
  HERO_STYLES,
  HERO_STYLES_BY_ID,
} from "./hero-styles";
import {
  deterministicStylePick,
  resolveHeroStyleFromContext,
  type HeroStyleResolutionContext,
} from "./hero-styles-resolver";

// Parity fixture. The values on the right are computed from the Python
// reference (`pipeline.stages.deterministic_style_pick`) using the
// exact same inputs. Both implementations MUST land on these values.
const FIXED_THREE_WHITELIST: ReadonlyArray<string> = ["a", "b", "c"];
const PARITY_FIXED_THREE: Record<string, string> = {
  envelope: "b",
  "cold-shower-revenge": "a",
  "parking-spot-war": "c",
  "s-1": "c",
  "s-2": "a",
  "s-3": "c",
  replyall: "b",
};
const PARITY_ENTITLED: Record<string, string> = {
  envelope: "retro_pulp",
  "cold-shower-revenge": "magazine_editorial",
  "parking-spot-war": "comic_book",
  "s-1": "comic_book",
  "s-2": "magazine_editorial",
  "s-3": "comic_book",
  replyall: "retro_pulp",
};

describe("deterministicStylePick", () => {
  it("matches the Python reference on a 3-element whitelist", () => {
    for (const [storyId, expected] of Object.entries(PARITY_FIXED_THREE)) {
      const got = deterministicStylePick(storyId, FIXED_THREE_WHITELIST);
      expect(got, `mismatch for storyId=${storyId}`).toBe(expected);
    }
  });

  it("matches the Python reference on the Entitled whitelist", () => {
    const entitled = CATEGORY_STYLE_WHITELIST["Entitled"];
    for (const [storyId, expected] of Object.entries(PARITY_ENTITLED)) {
      const got = deterministicStylePick(storyId, entitled);
      expect(got, `mismatch for storyId=${storyId}`).toBe(expected);
    }
  });

  it("is idempotent (same input → same output across calls)", () => {
    const id = "stable-story";
    const first = deterministicStylePick(id, FIXED_THREE_WHITELIST);
    const second = deterministicStylePick(id, FIXED_THREE_WHITELIST);
    expect(first).toBe(second);
  });

  it("distributes across the whitelist for a varied input set", () => {
    // 100 distinct ids over a 3-element list — P(missing any single
    // style) is ≈ 2e-18. If this fails the hash is broken.
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(deterministicStylePick(`story-${i}`, FIXED_THREE_WHITELIST));
    }
    expect(seen).toEqual(new Set(FIXED_THREE_WHITELIST));
  });

  it("throws on an empty allowed list (misconfigured whitelist)", () => {
    expect(() => deterministicStylePick("any", [])).toThrow(/empty/);
  });
});

describe("resolveHeroStyleFromContext", () => {
  function makeCtx(
    overrides: Partial<HeroStyleResolutionContext> = {},
  ): HeroStyleResolutionContext {
    return {
      pinnedId: null,
      category: "Drama",
      storyId: "s-default",
      globalStyleId: "",
      categoryDefaults: {},
      ...overrides,
    };
  }

  it("returns per_story when the story pin is set", () => {
    const r = resolveHeroStyleFromContext(
      makeCtx({ pinnedId: "comic_book", globalStyleId: "neo_noir" }),
    );
    expect(r.source).toBe("per_story");
    expect(r.style.id).toBe("comic_book");
    expect(r.whitelist).toEqual([]);
  });

  it("falls through to category_default when no story pin is set", () => {
    const r = resolveHeroStyleFromContext(
      makeCtx({
        category: "Drama",
        categoryDefaults: { drama: "painted_realism" },
      }),
    );
    expect(r.source).toBe("category_default");
    expect(r.style.id).toBe("painted_realism");
  });

  it("falls through to global_default when category default is empty", () => {
    const r = resolveHeroStyleFromContext(
      makeCtx({ globalStyleId: "vintage_hollywood" }),
    );
    expect(r.source).toBe("global_default");
    expect(r.style.id).toBe("vintage_hollywood");
  });

  it("falls through to auto_hash when every settings layer is empty", () => {
    const r = resolveHeroStyleFromContext(
      makeCtx({ category: "Entitled", storyId: "envelope" }),
    );
    expect(r.source).toBe("auto_hash");
    expect(r.whitelist).toEqual(CATEGORY_STYLE_WHITELIST["Entitled"]);
    expect(r.style.id).toBe("retro_pulp"); // from parity fixture
  });

  it("ignores an unknown pinned id and falls through", () => {
    // Stale/typoed per-story id must NOT crash; resolver punts to the
    // next layer just like the Python side.
    const r = resolveHeroStyleFromContext(
      makeCtx({
        pinnedId: "some_old_style_that_no_longer_exists",
        categoryDefaults: { drama: "neo_noir" },
      }),
    );
    expect(r.source).toBe("category_default");
    expect(r.style.id).toBe("neo_noir");
  });

  it("uses lowercased category for the settings key lookup", () => {
    // Story rows carry capitalized Cat names; the settings key is
    // lowercased. The resolver must bridge the casing so an admin who
    // sets 'hero.category_default.drama' actually catches Drama
    // stories.
    const r = resolveHeroStyleFromContext(
      makeCtx({
        category: "Drama",
        categoryDefaults: { drama: "painted_realism" },
      }),
    );
    expect(r.style.id).toBe("painted_realism");
  });

  it("unknown category falls back to Drama's whitelist at auto_hash", () => {
    const r = resolveHeroStyleFromContext(
      makeCtx({ category: "MadeUpCategory", storyId: "any" }),
    );
    expect(r.source).toBe("auto_hash");
    expect(r.whitelist).toEqual(CATEGORY_STYLE_WHITELIST["Drama"]);
  });

  it("returns the live HERO_STYLES_BY_ID object (not a copy)", () => {
    // Picker compares by reference in places; the resolved style MUST
    // be the same instance.
    const r = resolveHeroStyleFromContext(
      makeCtx({ pinnedId: "neo_noir" }),
    );
    expect(r.style).toBe(HERO_STYLES_BY_ID["neo_noir"]);
  });

  it("never returns a style outside HERO_STYLES", () => {
    // Defensive: even on a weird input combo the picker shouldn't get
    // an off-registry HeroStyle that would crash heroStyleSourceLabel.
    const knownIds = new Set(HERO_STYLES.map((s) => s.id));
    const r = resolveHeroStyleFromContext(makeCtx({ storyId: "anything" }));
    expect(knownIds.has(r.style.id)).toBe(true);
  });
});
