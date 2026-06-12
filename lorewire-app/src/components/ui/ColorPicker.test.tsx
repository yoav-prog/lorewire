// @vitest-environment happy-dom

// Tests the ColorPicker's CLOSED-state contract via renderToString.
// The popover open/close + clipboard + EyeDropper API are interaction
// paths that get exercised in Phase B's panel-level integration.

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { ColorPicker } from "./ColorPicker";

describe("ColorPicker — closed state", () => {
  it("renders the swatch button with the current color as background", () => {
    const html = renderToString(
      <ColorPicker value="#facc15" onChange={() => undefined} />,
    );
    expect(html).toContain('data-testid="color-picker-swatch"');
    expect(html).toContain("background:#facc15");
  });

  it("renders the hex input pre-filled with the current value", () => {
    const html = renderToString(
      <ColorPicker value="#facc15" onChange={() => undefined} />,
    );
    expect(html).toContain('value="#facc15"');
  });

  it("flags an invalid hex with aria-invalid=true", () => {
    const html = renderToString(
      <ColorPicker value="not-a-hex" onChange={() => undefined} />,
    );
    expect(html).toContain('aria-invalid="true"');
  });

  it("flags a valid hex with aria-invalid=false", () => {
    const html = renderToString(
      <ColorPicker value="#000000" onChange={() => undefined} />,
    );
    expect(html).toContain('aria-invalid="false"');
  });

  it("renders the label and binds it to the hex input via htmlFor", () => {
    const html = renderToString(
      <ColorPicker
        value="#000"
        onChange={() => undefined}
        label="Outline color"
      />,
    );
    expect(html).toContain("Outline color");
    expect(html).toMatch(/<label[^>]+for="/);
  });

  it("does NOT render the popover on first paint (closed state)", () => {
    const html = renderToString(
      <ColorPicker value="#000" onChange={() => undefined} />,
    );
    expect(html).not.toContain('data-testid="color-picker-popover"');
  });

  it("disables the swatch + hex input when disabled is true", () => {
    const html = renderToString(
      <ColorPicker value="#000" onChange={() => undefined} disabled />,
    );
    // Two `disabled` attributes (one per interactive element).
    const matches = html.match(/disabled=""/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
