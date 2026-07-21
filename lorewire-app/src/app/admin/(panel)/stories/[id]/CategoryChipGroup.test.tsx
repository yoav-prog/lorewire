// @vitest-environment happy-dom

// CategoryChipGroup tests. The component is a controlled chip group
// whose hidden input carries the picked category label into the
// surrounding form (saveStory action). Data-driven since the 2026-07-01
// taxonomy arc: the server tab passes the active `categories` rows down
// as options. Tests cover:
//   - one chip per passed option renders with its label + inline tint
//   - the initial value is reflected as the selected chip + hidden input
//   - an out-of-set initial value (legacy label) renders as an extra
//     leading chip, selected, so a no-touch save is a no-op
//   - an empty initial selects nothing
//   - the outer wrapper is role="radiogroup"

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { CategoryChipGroup } from "./CategoryChipGroup";
import { GRANULAR_CATEGORIES } from "@/lib/categories/granular";

// Same shape OverviewTab passes: the active DB rows' label + hex.
const OPTIONS = GRANULAR_CATEGORIES.map((c) => ({
  label: c.label,
  color: c.color,
}));

describe("CategoryChipGroup", () => {
  it("renders one chip per passed option", () => {
    const html = renderToString(
      <CategoryChipGroup
        name="category"
        initial="Family Feuds"
        options={OPTIONS}
      />,
    );
    for (const opt of OPTIONS) {
      // renderToString HTML-escapes attribute values ("&" -> "&amp;").
      expect(html).toContain(`data-cat="${opt.label.replace(/&/g, "&amp;")}"`);
    }
  });

  it("marks the initial category as aria-checked", () => {
    const html = renderToString(
      <CategoryChipGroup
        name="category"
        initial="Wedding Drama"
        options={OPTIONS}
      />,
    );
    expect(html).toMatch(
      /aria-checked="true"[^>]*data-cat="Wedding Drama"|data-cat="Wedding Drama"[^>]*aria-checked="true"/,
    );
  });

  it("seeds the hidden input with the initial value", () => {
    const html = renderToString(
      <CategoryChipGroup
        name="category"
        initial="Wholesome Wins"
        options={OPTIONS}
      />,
    );
    expect(html).toContain('name="category"');
    expect(html).toContain('value="Wholesome Wins"');
  });

  it("keeps an out-of-set initial value as an extra selected chip", () => {
    // A story still carrying a legacy label must stay visible and a
    // no-touch save must submit the unchanged value.
    const html = renderToString(
      <CategoryChipGroup name="category" initial="Drama" options={OPTIONS} />,
    );
    expect(html).toMatch(
      /aria-checked="true"[^>]*data-cat="Drama"|data-cat="Drama"[^>]*aria-checked="true"/,
    );
    expect(html).toContain('value="Drama"');
    // The active set still renders alongside it.
    expect(html).toContain('data-cat="Entitled People"');
  });

  it("selects nothing when the initial value is empty", () => {
    const html = renderToString(
      <CategoryChipGroup name="category" initial="" options={OPTIONS} />,
    );
    expect(html).not.toContain('aria-checked="true"');
    expect(html).toContain('value=""');
  });

  it("renders the outer wrapper as a radiogroup", () => {
    const html = renderToString(
      <CategoryChipGroup
        name="category"
        initial="Breakups"
        options={OPTIONS}
      />,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Category"');
  });
});
