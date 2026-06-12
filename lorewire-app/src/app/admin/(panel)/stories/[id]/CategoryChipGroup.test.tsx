// @vitest-environment happy-dom

// CategoryChipGroup tests. The component is a controlled chip group
// whose hidden input carries the picked category into the surrounding
// form (saveStory action). Tests cover:
//   - one chip per category renders with its label + colour dot
//   - the initial value is reflected as the selected chip + hidden input
//   - an unknown initial value falls back to "Entitled" so a bad row
//     in the DB doesn't crash the page
//   - the outer wrapper is role="radiogroup"

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { CategoryChipGroup } from "./CategoryChipGroup";
import { CATEGORIES } from "@/app/admin/ui";

describe("CategoryChipGroup", () => {
  it("renders one chip per known category", () => {
    const html = renderToString(
      <CategoryChipGroup name="category" initial="Drama" />,
    );
    for (const cat of CATEGORIES) {
      expect(html).toContain(`data-cat="${cat}"`);
      expect(html).toContain(cat);
    }
  });

  it("marks the initial category as aria-checked", () => {
    const html = renderToString(
      <CategoryChipGroup name="category" initial="Humor" />,
    );
    expect(html).toMatch(
      /aria-checked="true"[^>]*data-cat="Humor"|data-cat="Humor"[^>]*aria-checked="true"/,
    );
  });

  it("seeds the hidden input with the initial value", () => {
    const html = renderToString(
      <CategoryChipGroup name="category" initial="Wholesome" />,
    );
    expect(html).toContain('name="category"');
    expect(html).toContain('value="Wholesome"');
  });

  it("falls back to Entitled when the initial value is not a known category", () => {
    const html = renderToString(
      <CategoryChipGroup name="category" initial="NotARealCategory" />,
    );
    expect(html).toMatch(
      /aria-checked="true"[^>]*data-cat="Entitled"|data-cat="Entitled"[^>]*aria-checked="true"/,
    );
    expect(html).toContain('value="Entitled"');
  });

  it("renders the outer wrapper as a radiogroup", () => {
    const html = renderToString(
      <CategoryChipGroup name="category" initial="Drama" />,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Category"');
  });
});
