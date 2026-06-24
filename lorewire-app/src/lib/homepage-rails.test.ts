// resolveRailIds resolution-order coverage. The Phase 2 anonymous-first
// work added a third tier between "admin curation" and "static catalog
// fallback": the user's own Continue Watching list from the
// engagement-store. The order matters — getting it wrong silently steals
// the admin's override or hides the user's real progress.

import { describe, expect, it } from "vitest";

import {
  fallbackIdsForSurface,
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

// `heroImage: "x"` is what makes each fixture pass isPublishedStory.
// Without it, fallbackIdsForSurface filters every fixture out and the
// resolution-order tests below all return [] instead of the catalog
// order they assert.
const catalog = {
  array: [
    { id: "s_a", heroImage: "x" },
    { id: "s_b", heroImage: "x" },
    { id: "s_c", heroImage: "x" },
    { id: "s_d", heroImage: "x" },
    { id: "s_e", heroImage: "x" },
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

// 2026-06-24 regression: production rails crashed to 0-2 items because
// fallbackIdsForSurface sliced 6 candidates by category BEFORE filtering
// by isPublishedStory. Sample placeholders and in-progress live rows
// (no hero artwork yet) consumed slots that real published stories
// never got. These tests pin "filter before slice" so the bug can't
// silently come back.
describe("fallbackIdsForSurface — filter-before-slice (2026-06-24 fix)", () => {
  const publishedDrama = (id: string) => ({
    id,
    cat: "Drama",
    heroImage: "x",
  });
  const unpublishedDrama = (id: string) => ({ id, cat: "Drama" });

  it("drops unpublished entries from the rail", () => {
    const result = fallbackIdsForSurface("drama_row", [
      unpublishedDrama("u1"),
      unpublishedDrama("u2"),
      publishedDrama("p1"),
      publishedDrama("p2"),
      publishedDrama("p3"),
      publishedDrama("p4"),
    ] as never);
    expect(result).toEqual(["p1", "p2", "p3", "p4"]);
  });

  it("returns published stories beyond catalog position 6 — the regression case", () => {
    const stories = [
      // First 6 slots are sample placeholders (no heroImage).
      unpublishedDrama("u1"),
      unpublishedDrama("u2"),
      unpublishedDrama("u3"),
      unpublishedDrama("u4"),
      unpublishedDrama("u5"),
      unpublishedDrama("u6"),
      // Real published Dramas live at positions 6+.
      publishedDrama("p1"),
      publishedDrama("p2"),
      publishedDrama("p3"),
      publishedDrama("p4"),
    ];
    const result = fallbackIdsForSurface("drama_row", stories as never);
    // Old (buggy) behavior: returns [] because slice(0, 6) only saw the
    // unpublished entries. New behavior: returns the four real published
    // Dramas regardless of position.
    expect(result).toEqual(["p1", "p2", "p3", "p4"]);
  });

  it("caps at 20 to keep SSR payload bounded", () => {
    const stories = Array.from({ length: 50 }, (_, i) =>
      publishedDrama(`p${i}`),
    );
    const result = fallbackIdsForSurface("drama_row", stories as never);
    expect(result).toHaveLength(20);
    expect(result[0]).toBe("p0");
    expect(result[19]).toBe("p19");
  });

  it("returns empty when no stories in the catalog pass isPublishedStory", () => {
    const result = fallbackIdsForSurface("drama_row", [
      unpublishedDrama("u1"),
      unpublishedDrama("u2"),
    ] as never);
    expect(result).toEqual([]);
  });

  it("new_row sorts by year DESC after filtering by published", () => {
    const result = fallbackIdsForSurface("new_row", [
      { id: "u_2030", year: 2030 }, // unpublished — must NOT bubble to the top
      { id: "p_2024", year: 2024, heroImage: "x" },
      { id: "p_2026", year: 2026, heroImage: "x" },
      { id: "p_2025", year: 2025, heroImage: "x" },
    ] as never);
    expect(result).toEqual(["p_2026", "p_2025", "p_2024"]);
  });
});
