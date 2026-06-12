// @vitest-environment happy-dom

// Tests for the AspectChipGroup primitive. Phase 4 of
// _plans/2026-06-12-video-aspect-ratio.md. The component wraps the Phase A
// ChipGroup with two preset options + frame-shape previews; tests pin:
//   - both aspects render with their visible labels
//   - the selected aspect carries aria-checked=true (RTL UX contract)
//   - the disabled state cascades down to each chip
//   - the outer wrapper is a role=radiogroup

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { AspectChipGroup, ASPECT_CHIP_OPTIONS } from "./AspectChipGroup";

describe("AspectChipGroup", () => {
  it("renders one chip per supported aspect", () => {
    const html = renderToString(
      <AspectChipGroup value="9:16" onChange={() => undefined} />,
    );
    expect(html).toContain('data-chip-id="16:9"');
    expect(html).toContain('data-chip-id="9:16"');
    expect(html).toContain("16:9 wide");
    expect(html).toContain("9:16 tall");
  });

  it("marks only the selected aspect with aria-checked=true", () => {
    const html = renderToString(
      <AspectChipGroup value="16:9" onChange={() => undefined} />,
    );
    expect(html).toMatch(
      /aria-checked="true"[^>]*data-chip-id="16:9"|data-chip-id="16:9"[^>]*aria-checked="true"/,
    );
    expect(html).toMatch(
      /aria-checked="false"[^>]*data-chip-id="9:16"|data-chip-id="9:16"[^>]*aria-checked="false"/,
    );
  });

  it("disables every chip when disabled=true", () => {
    const html = renderToString(
      <AspectChipGroup value="9:16" onChange={() => undefined} disabled />,
    );
    const matches = html.match(/disabled=""/g) ?? [];
    expect(matches.length).toBe(ASPECT_CHIP_OPTIONS.length);
  });

  it("renders the outer wrapper as a radiogroup", () => {
    const html = renderToString(
      <AspectChipGroup value="9:16" onChange={() => undefined} />,
    );
    expect(html).toContain('role="radiogroup"');
  });

  it("uses the label or 'Aspect ratio' as the aria-label", () => {
    const withLabel = renderToString(
      <AspectChipGroup
        value="9:16"
        onChange={() => undefined}
        label="Story aspect"
      />,
    );
    expect(withLabel).toContain('aria-label="Story aspect"');
    const noLabel = renderToString(
      <AspectChipGroup value="9:16" onChange={() => undefined} />,
    );
    expect(noLabel).toContain('aria-label="Aspect ratio"');
  });
});
