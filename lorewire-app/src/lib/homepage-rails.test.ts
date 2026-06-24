// resolveRailIds resolution-order coverage. The Phase 2 anonymous-first
// work added a third tier between "admin curation" and "static catalog
// fallback": the user's own Continue Watching list from the
// engagement-store. The order matters — getting it wrong silently steals
// the admin's override or hides the user's real progress.

import { describe, expect, it } from "vitest";

import {
  MIN_PUBLIC_RAIL_SIZE,
  hasEnoughForPublicRail,
  resolveRailIds,
} from "./homepage-rails";

const BEHAVIOR_FALLBACK = {
  emptyRailBehavior: "fallback" as const,
  heroRequired: false,
};
const BEHAVIOR_HIDE = {
  emptyRailBehavior: "hide" as const,
  heroRequired: false,
};

const catalog = {
  array: [
    { id: "s_a" },
    { id: "s_b" },
    { id: "s_c" },
    { id: "s_d" },
    { id: "s_e" },
  ],
  // The Map is unused by resolveRailIds; the array shape is what
  // fallbackIdsForSurface reads.
  map: new Map(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe("resolveRailIds — continue rail resolution order", () => {
  it("returns admin curation when present (beats user state)", () => {
    const curation = {
      hero: [],
      top10: [],
      continue: ["s_admin_1", "s_admin_2"],
      new_row: [],
      drama_row: [],
      entitled_row: [],
      humor_row: [],
      wholesome_row: [],
      dating_row: [],
      roommate_row: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = resolveRailIds(
      "continue",
      curation,
      BEHAVIOR_FALLBACK,
      catalog,
      { continue: ["s_user_1"] },
    );
    expect(result).toEqual(["s_admin_1", "s_admin_2"]);
  });

  it("returns user continue state when curation is empty", () => {
    const curation = {
      hero: [],
      top10: [],
      continue: [],
      new_row: [],
      drama_row: [],
      entitled_row: [],
      humor_row: [],
      wholesome_row: [],
      dating_row: [],
      roommate_row: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = resolveRailIds(
      "continue",
      curation,
      BEHAVIOR_FALLBACK,
      catalog,
      { continue: ["s_user_1", "s_user_2"] },
    );
    expect(result).toEqual(["s_user_1", "s_user_2"]);
  });

  it("falls back to catalog when both curation and user state empty", () => {
    const curation = {
      hero: [],
      top10: [],
      continue: [],
      new_row: [],
      drama_row: [],
      entitled_row: [],
      humor_row: [],
      wholesome_row: [],
      dating_row: [],
      roommate_row: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = resolveRailIds(
      "continue",
      curation,
      BEHAVIOR_FALLBACK,
      catalog,
      { continue: [] },
    );
    // fallbackIdsForSurface("continue", catalog.array) returns the first
    // 4 ids in catalog order.
    expect(result).toEqual(["s_a", "s_b", "s_c", "s_d"]);
  });

  it("user continue state beats the hide behavior", () => {
    // A homepage configured to hide empty rails should NOT hide when the
    // user has real progress — that's the whole point of the user-state
    // override.
    const curation = {
      hero: [],
      top10: [],
      continue: [],
      new_row: [],
      drama_row: [],
      entitled_row: [],
      humor_row: [],
      wholesome_row: [],
      dating_row: [],
      roommate_row: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = resolveRailIds(
      "continue",
      curation,
      BEHAVIOR_HIDE,
      catalog,
      { continue: ["s_user_1"] },
    );
    expect(result).toEqual(["s_user_1"]);
  });

  it("ignores userOverrides.continue for non-continue surfaces", () => {
    // top10 shouldn't get the user's continue state — the override only
    // applies to the surface it's named for.
    const curation = {
      hero: [],
      top10: [],
      continue: [],
      new_row: [],
      drama_row: [],
      entitled_row: [],
      humor_row: [],
      wholesome_row: [],
      dating_row: [],
      roommate_row: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = resolveRailIds(
      "top10",
      curation,
      BEHAVIOR_FALLBACK,
      catalog,
      { continue: ["s_user_1"] },
    );
    expect(result).not.toContain("s_user_1");
  });
});

describe("hasEnoughForPublicRail — homepage discovery threshold", () => {
  it("rejects an empty rail", () => {
    expect(hasEnoughForPublicRail(0)).toBe(false);
  });

  it("rejects rails below MIN_PUBLIC_RAIL_SIZE", () => {
    for (let n = 1; n < MIN_PUBLIC_RAIL_SIZE; n += 1) {
      expect(hasEnoughForPublicRail(n)).toBe(false);
    }
  });

  it("accepts rails at exactly MIN_PUBLIC_RAIL_SIZE", () => {
    expect(hasEnoughForPublicRail(MIN_PUBLIC_RAIL_SIZE)).toBe(true);
  });

  it("accepts rails larger than the threshold", () => {
    expect(hasEnoughForPublicRail(MIN_PUBLIC_RAIL_SIZE + 1)).toBe(true);
    expect(hasEnoughForPublicRail(100)).toBe(true);
  });
});
