// @vitest-environment happy-dom

// Pins the PositionPicker's visual contract via renderToString. The
// pointer-drag math is exercised by the Overlays panel's integration
// tests; this file locks the rendered output the user sees.

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { PositionPicker } from "./PositionPicker";

describe("PositionPicker", () => {
  it("renders a 9:16 box with a draggable dot", () => {
    const html = renderToString(
      <PositionPicker x={0.5} y={0.5} onChange={() => undefined} />,
    );
    expect(html).toContain('data-testid="position-picker-box"');
    expect(html).toContain('data-testid="position-picker-dot"');
    expect(html).toContain("aspect-ratio:9 / 16");
  });

  it("paints the box cream so it reads as a stand-in for the composition", () => {
    const html = renderToString(
      <PositionPicker x={0.5} y={0.5} onChange={() => undefined} />,
    );
    expect(html).toContain("background:#fbfaf4");
  });

  it("positions the dot by percentage of the 0..1 coords", () => {
    const html = renderToString(
      <PositionPicker x={0.25} y={0.75} onChange={() => undefined} />,
    );
    // Dot's left = 25%, top = 75%.
    expect(html).toMatch(/position-picker-dot[^>]+left:\s*25%/);
    expect(html).toMatch(/position-picker-dot[^>]+top:\s*75%/);
  });

  it("clamps out-of-range coords to 0..1 (defensive)", () => {
    const html = renderToString(
      <PositionPicker x={-1} y={2} onChange={() => undefined} />,
    );
    expect(html).toMatch(/position-picker-dot[^>]+left:\s*0%/);
    expect(html).toMatch(/position-picker-dot[^>]+top:\s*100%/);
  });

  it("renders the label and formatted current value", () => {
    const html = renderToString(
      <PositionPicker
        x={0.33}
        y={0.66}
        label="Overlay position"
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("Overlay position");
    // React 19 inserts hydration markers (<!-- -->) between adjacent
    // text nodes, so "0.33, 0.66" renders as "0.33<!-- -->, <!-- -->0.66".
    // Assert both halves are present and comma-joined.
    expect(html).toMatch(/0\.33[^<]*<!--[^>]*-->[^<]*,[^<]*<!--[^>]*-->[^<]*0\.66|0\.33,\s*0\.66/);
  });

  it("exposes an accessible aria-label describing the current position", () => {
    const html = renderToString(
      <PositionPicker x={0.5} y={0.5} onChange={() => undefined} />,
    );
    expect(html).toMatch(
      /aria-label="Position picker, currently x 0\.50, y 0\.50"/,
    );
  });

  it("renders TL/TR/BL/BR corner orientation labels", () => {
    const html = renderToString(
      <PositionPicker x={0.5} y={0.5} onChange={() => undefined} />,
    );
    expect(html).toContain(">tl<");
    expect(html).toContain(">tr<");
    expect(html).toContain(">bl<");
    expect(html).toContain(">br<");
  });

  it("dims the wrapper when disabled", () => {
    const html = renderToString(
      <PositionPicker
        x={0.5}
        y={0.5}
        disabled
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("opacity-50");
  });

  it("respects a custom maxWidth", () => {
    const html = renderToString(
      <PositionPicker
        x={0.5}
        y={0.5}
        maxWidth={240}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("max-width:240px");
  });
});
