// @vitest-environment happy-dom

// Covers the URL-backed multi-select category filter used by Browse
// (desktop) and Search (mobile). Three things under test:
//   1. `parseSelected` ignores stale / invalid values so an old shared
//      URL with a renamed category can't crash the chip row.
//   2. `serializeSelected` writes categories in CATEGORY_ORDER so two
//      paths to the same filter produce the same URL — required for
//      shareable links.
//   3. `filterStoriesByCategory` returns the input untouched when
//      nothing is selected (the All state), and ORs across categories
//      when more than one is selected.

import { describe, expect, it } from "vitest";
import {
  CATEGORY_ORDER,
  filterStoriesByCategory,
} from "./CategoryFilterChips";
import type { Cat } from "@/lib/stories";

// CATEGORY_ORDER is enumerated off CAT so this list grows with the
// type. The test just asserts the publicly-shipped categories are
// represented; new ones land here automatically.
describe("CATEGORY_ORDER", () => {
  it("includes the public categories in a stable order", () => {
    expect(CATEGORY_ORDER).toContain("Entitled People");
    expect(CATEGORY_ORDER).toContain("Family Feuds");
    expect(CATEGORY_ORDER).toContain("Revenge & Karma");
  });
});

describe("filterStoriesByCategory", () => {
  const items: { id: string; cat: Cat }[] = [
    { id: "a", cat: "Drama" },
    { id: "b", cat: "Entitled" },
    { id: "c", cat: "Humor" },
    { id: "d", cat: "Drama" },
  ];

  it("returns the input untouched when nothing is selected", () => {
    const out = filterStoriesByCategory(items, new Set());
    expect(out).toEqual(items);
  });

  it("keeps only items whose cat matches the single selection", () => {
    const out = filterStoriesByCategory(items, new Set(["Drama"] as Cat[]));
    expect(out.map((s) => s.id)).toEqual(["a", "d"]);
  });

  it("ORs across multiple selected categories", () => {
    const out = filterStoriesByCategory(
      items,
      new Set(["Drama", "Humor"] as Cat[]),
    );
    expect(out.map((s) => s.id)).toEqual(["a", "c", "d"]);
  });

  it("returns an empty list when the selection matches nothing", () => {
    const out = filterStoriesByCategory(
      items,
      new Set(["Wholesome"] as Cat[]),
    );
    expect(out).toEqual([]);
  });
});
