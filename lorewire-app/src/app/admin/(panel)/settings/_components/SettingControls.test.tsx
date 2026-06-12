// @vitest-environment happy-dom

// Phase D smoke tests for the SettingSlider rebuild. We pin:
//   - The new SettingSlider renders the label, hint, and Phase A
//     Slider with the right initial value.
//   - The back-compat SettingNumber wrapper still renders without
//     crashing — every existing call site keeps working until we
//     migrate them piecewise.
//   - The "garbage initial string" path falls back to min rather
//     than throwing or rendering NaN.
//
// The save-action plumbing itself is exercised by useDebouncedSave's
// own tests; this file pins the surface the Settings page exposes.

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { SettingNumber, SettingSlider } from "./SettingControls";

// saveSettingAction reaches into setSetting → repo → DB. Stub it so
// the smoke test doesn't pull the whole server graph in. The test
// doesn't actually invoke the action; it just renders.
vi.mock("@/app/admin/actions", () => ({
  saveSettingAction: vi.fn(async () => undefined),
}));

describe("SettingSlider", () => {
  it("renders the label, hint, and the embedded Slider", () => {
    const html = renderToString(
      <SettingSlider
        settingKey="pipeline.limit"
        label="Posts per run"
        hint="How many posts to process"
        initial="5"
        min={1}
        max={20}
      />,
    );
    expect(html).toContain("Posts per run");
    expect(html).toContain("How many posts to process");
    expect(html).toContain('data-testid="slider"');
    expect(html).toContain('value="5"');
  });

  it("forwards unit + tickValue + endpoints to the Slider", () => {
    const html = renderToString(
      <SettingSlider
        settingKey="budget.daily_usd"
        label="Daily cap"
        initial="5"
        min={1}
        max={500}
        unit="$"
        tickValue={5}
        endpoints={["MIN", "MAX"]}
      />,
    );
    expect(html).toContain("$");
    expect(html).toContain("MIN");
    expect(html).toContain("MAX");
    expect(html).toContain('data-testid="slider-tick"');
  });

  it("falls back to min when initial parses to NaN", () => {
    const html = renderToString(
      <SettingSlider
        settingKey="pipeline.limit"
        label="Posts per run"
        initial="not-a-number"
        min={1}
        max={20}
      />,
    );
    expect(html).toContain('value="1"');
  });

  it("clamps an out-of-range initial value to the [min, max] window", () => {
    const html = renderToString(
      <SettingSlider
        settingKey="pipeline.limit"
        label="Posts per run"
        initial="9999"
        min={1}
        max={20}
      />,
    );
    expect(html).toContain('value="20"');
  });
});

describe("SettingNumber (back-compat wrapper)", () => {
  it("still renders by forwarding to SettingSlider", () => {
    const html = renderToString(
      <SettingNumber
        settingKey="media.scene_count"
        label="Scenes per story"
        initial="30"
        min={6}
        max={60}
      />,
    );
    // The wrapper exposes the same label + slider surface so existing
    // call sites need no edits.
    expect(html).toContain("Scenes per story");
    expect(html).toContain('data-testid="slider"');
    expect(html).toContain('value="30"');
  });

  it("maps the legacy `prefix` arg onto the Slider's unit display", () => {
    const html = renderToString(
      <SettingNumber
        settingKey="budget.daily_usd"
        label="Daily cap"
        initial="5"
        min={1}
        max={500}
        prefix="$"
      />,
    );
    expect(html).toContain("$");
  });
});
