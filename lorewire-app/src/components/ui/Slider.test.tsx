// @vitest-environment happy-dom

// Pins the Slider's visual + behavioural contract.

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { Slider } from "./Slider";

describe("Slider", () => {
  it("renders a real <input type=range> with the right min/max/step", () => {
    const html = renderToString(
      <Slider
        value={0.55}
        min={0}
        max={1}
        step={0.01}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('type="range"');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="1"');
    expect(html).toContain('step="0.01"');
    expect(html).toContain('value="0.55"');
  });

  it("renders the label and the current value with default precision", () => {
    const html = renderToString(
      <Slider
        value={0.55}
        min={0}
        max={1}
        step={0.01}
        label="Position Y"
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("Position Y");
    expect(html).toContain("0.55");
  });

  it("formats integer-step values without decimals", () => {
    const html = renderToString(
      <Slider
        value={64}
        min={0}
        max={200}
        step={1}
        label="Side padding"
        unit="px"
        onChange={() => undefined}
      />,
    );
    // Step >= 1 -> precision 0, so "64" not "64.0".
    expect(html).toContain(">64<");
    expect(html).toContain("px");
  });

  it("respects an explicit precision override", () => {
    // Value display only renders when a label is present (otherwise
    // the slider is decoration only, no readout). Pass a label so the
    // formatted value lands in the HTML.
    const html = renderToString(
      <Slider
        value={1.234567}
        min={0}
        max={2}
        step={0.001}
        precision={4}
        label="Test"
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("1.2346");
  });

  it("renders endpoint labels when supplied", () => {
    const html = renderToString(
      <Slider
        value={0.55}
        min={0}
        max={1}
        step={0.01}
        endpoints={["TOP", "BOTTOM"]}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("TOP");
    expect(html).toContain("BOTTOM");
  });

  it("renders a tick mark when tickValue is in range", () => {
    const html = renderToString(
      <Slider
        value={1.5}
        min={0.5}
        max={2}
        step={0.05}
        tickValue={1}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="slider-tick"');
  });

  it("does NOT render a tick when tickValue is undefined", () => {
    const html = renderToString(
      <Slider
        value={1.5}
        min={0.5}
        max={2}
        step={0.05}
        onChange={() => undefined}
      />,
    );
    expect(html).not.toContain('data-testid="slider-tick"');
  });

  it("dims the wrapper when disabled", () => {
    const html = renderToString(
      <Slider
        value={1}
        min={0}
        max={2}
        step={0.1}
        disabled
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("opacity-50");
  });

  it("uses ariaLabel when provided, otherwise falls back to label", () => {
    const explicit = renderToString(
      <Slider
        value={1}
        min={0}
        max={2}
        step={0.1}
        ariaLabel="Custom aria"
        onChange={() => undefined}
      />,
    );
    expect(explicit).toContain('aria-label="Custom aria"');

    const fromLabel = renderToString(
      <Slider
        value={1}
        min={0}
        max={2}
        step={0.1}
        label="Volume"
        onChange={() => undefined}
      />,
    );
    expect(fromLabel).toContain('aria-label="Volume"');
  });
});
