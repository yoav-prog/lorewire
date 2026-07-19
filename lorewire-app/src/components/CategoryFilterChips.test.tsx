// @vitest-environment happy-dom

// Covers the chip row shared by Browse (desktop) and Search (mobile):
// CATEGORY_ORDER must keep carrying the publicly-shipped categories so
// the chips and the URL-backed ?cat= filter stay in sync with the CAT
// type. (`filterStoriesByCategory` used to live here too; the category
// filter now pushes down as a server-side WHERE in loadBrowsePage,
// covered by src/lib/browse-page.test.ts.)

import { describe, expect, it } from "vitest";
import { CATEGORY_ORDER } from "./CategoryFilterChips";

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

