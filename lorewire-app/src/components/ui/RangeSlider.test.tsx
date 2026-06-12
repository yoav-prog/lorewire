// @vitest-environment happy-dom

// Pins the RangeSlider's visual + accessibility contract via
// renderToString. Pointer-drag behaviour is exercised by Phase C's
// integration tests on the Trim panel; the math (snap + clamp) is
// exposed implicitly through the rendered handle positions.

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { RangeSlider } from "./RangeSlider";

describe("RangeSlider", () => {
  it("renders two slider handles with role=slider", () => {
    const html = renderToString(
      <RangeSlider
        low={0}
        high={100}
        min={0}
        max={100}
        step={1}
        onChange={() => undefined}
      />,
    );
    const sliderMatches = html.match(/role="slider"/g);
    expect(sliderMatches?.length ?? 0).toBe(2);
    expect(html).toContain('data-testid="range-slider-handle-low"');
    expect(html).toContain('data-testid="range-slider-handle-high"');
  });

  it("renders the filled middle band between the handles", () => {
    const html = renderToString(
      <RangeSlider
        low={20}
        high={80}
        min={0}
        max={100}
        step={1}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="range-slider-fill"');
    // Fill should start at 20% and span 60% (80-20).
    expect(html).toMatch(/left:\s*20%/);
    expect(html).toMatch(/width:\s*60%/);
  });

  it("positions each handle by percentage of the range", () => {
    const html = renderToString(
      <RangeSlider
        low={25}
        high={75}
        min={0}
        max={100}
        step={1}
        onChange={() => undefined}
      />,
    );
    // Two `left:` declarations on handles. Match them explicitly so
    // the test fails clearly if percentages drift.
    expect(html).toMatch(/handle-low[^>]+left:\s*25%/);
    expect(html).toMatch(/handle-high[^>]+left:\s*75%/);
  });

  it("renders the label and the formatted values", () => {
    const html = renderToString(
      <RangeSlider
        low={1230}
        high={45670}
        min={0}
        max={50000}
        step={50}
        label="Trim window"
        formatValue={(n) => `${(n / 1000).toFixed(2)}s`}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("Trim window");
    expect(html).toContain("1.23s");
    expect(html).toContain("45.67s");
  });

  it("exposes aria-valuemin / aria-valuemax / aria-valuenow on both handles", () => {
    const html = renderToString(
      <RangeSlider
        low={20}
        high={80}
        min={0}
        max={100}
        step={1}
        onChange={() => undefined}
      />,
    );
    // Low handle: valuemin = min(0), valuemax = high(80), valuenow = low(20).
    expect(html).toMatch(
      /aria-valuemin="0"\s+aria-valuemax="80"\s+aria-valuenow="20"[^>]*data-testid="range-slider-handle-low"/,
    );
    // High handle: valuemin = low(20), valuemax = max(100), valuenow = high(80).
    expect(html).toMatch(
      /aria-valuemin="20"\s+aria-valuemax="100"\s+aria-valuenow="80"[^>]*data-testid="range-slider-handle-high"/,
    );
  });

  it("uses the provided ariaLabelLow / ariaLabelHigh", () => {
    const html = renderToString(
      <RangeSlider
        low={0}
        high={100}
        min={0}
        max={100}
        step={1}
        ariaLabelLow="Clip start"
        ariaLabelHigh="Clip end"
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('aria-label="Clip start"');
    expect(html).toContain('aria-label="Clip end"');
  });

  it("renders endpoint labels when supplied", () => {
    const html = renderToString(
      <RangeSlider
        low={0}
        high={100}
        min={0}
        max={100}
        step={1}
        endpoints={["START", "END"]}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("START");
    expect(html).toContain("END");
  });

  it("dims the wrapper when disabled", () => {
    const html = renderToString(
      <RangeSlider
        low={0}
        high={100}
        min={0}
        max={100}
        step={1}
        disabled
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("opacity-50");
  });

  it("uses String() formatter when no formatValue is supplied", () => {
    const html = renderToString(
      <RangeSlider
        low={1234}
        high={5678}
        min={0}
        max={10000}
        step={1}
        label="Plain"
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("1234");
    expect(html).toContain("5678");
  });
});
