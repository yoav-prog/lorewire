// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { ChipGroup, type ChipOption } from "./ChipGroup";

const OPTIONS: ChipOption<"none" | "fade" | "pop">[] = [
  { id: "none", label: "None" },
  { id: "fade", label: "Fade", preview: <span data-test-preview="fade" /> },
  { id: "pop", label: "Pop", hint: "Bouncy entrance" },
];

describe("ChipGroup", () => {
  it("renders one chip per option with its label", () => {
    const html = renderToString(
      <ChipGroup
        value="none"
        options={OPTIONS}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("None");
    expect(html).toContain("Fade");
    expect(html).toContain("Pop");
  });

  it("marks only the selected chip with aria-checked=true", () => {
    const html = renderToString(
      <ChipGroup
        value="fade"
        options={OPTIONS}
        onChange={() => undefined}
      />,
    );
    // React's attribute order: aria-checked comes before data-chip-id
    // in serialised HTML. Match both possible orderings so the test
    // doesn't break if React's serialiser changes.
    expect(html).toMatch(
      /aria-checked="true"[^>]*data-chip-id="fade"|data-chip-id="fade"[^>]*aria-checked="true"/,
    );
    expect(html).toMatch(
      /aria-checked="false"[^>]*data-chip-id="none"|data-chip-id="none"[^>]*aria-checked="false"/,
    );
    expect(html).toMatch(
      /aria-checked="false"[^>]*data-chip-id="pop"|data-chip-id="pop"[^>]*aria-checked="false"/,
    );
  });

  it("renders the preview slot when supplied", () => {
    const html = renderToString(
      <ChipGroup
        value="none"
        options={OPTIONS}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('data-test-preview="fade"');
  });

  it("uses the hint as a title attribute", () => {
    const html = renderToString(
      <ChipGroup
        value="none"
        options={OPTIONS}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('title="Bouncy entrance"');
  });

  it("renders the outer wrapper as role=radiogroup", () => {
    const html = renderToString(
      <ChipGroup
        value="none"
        options={OPTIONS}
        onChange={() => undefined}
        label="Entry effect"
      />,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Entry effect"');
    expect(html).toContain("Entry effect");
  });

  it("renders a chip as a role=radio button", () => {
    const html = renderToString(
      <ChipGroup
        value="none"
        options={OPTIONS}
        onChange={() => undefined}
      />,
    );
    expect(html).toMatch(/<button[^>]+role="radio"/);
  });

  it("disables every chip when disabled is true", () => {
    const html = renderToString(
      <ChipGroup
        value="none"
        options={OPTIONS}
        onChange={() => undefined}
        disabled
      />,
    );
    // Every chip carries `disabled=""`.
    const matches = html.match(/disabled=""/g);
    expect(matches?.length ?? 0).toBe(OPTIONS.length);
  });
});
