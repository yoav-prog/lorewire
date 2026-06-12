// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { Toggle } from "./Toggle";

describe("Toggle", () => {
  it("renders a switch with role=switch and aria-checked", () => {
    const html = renderToString(
      <Toggle checked={true} onChange={() => undefined} />,
    );
    expect(html).toMatch(/role="switch"[^>]+aria-checked="true"/);
  });

  it("aria-checked flips to false when unchecked", () => {
    const html = renderToString(
      <Toggle checked={false} onChange={() => undefined} />,
    );
    expect(html).toMatch(/role="switch"[^>]+aria-checked="false"/);
  });

  it("carries a data-checked attribute matching the prop", () => {
    const on = renderToString(
      <Toggle checked={true} onChange={() => undefined} />,
    );
    expect(on).toContain('data-checked="true"');

    const off = renderToString(
      <Toggle checked={false} onChange={() => undefined} />,
    );
    expect(off).toContain('data-checked="false"');
  });

  it("renders the label and hint when supplied", () => {
    const html = renderToString(
      <Toggle
        checked={false}
        onChange={() => undefined}
        label="Ken Burns"
        hint="Slow zoom/pan per frame"
      />,
    );
    expect(html).toContain("Ken Burns");
    expect(html).toContain("Slow zoom/pan per frame");
  });

  it("shows on/off text by default and honours rightLabel override", () => {
    const onHtml = renderToString(
      <Toggle checked={true} onChange={() => undefined} />,
    );
    expect(onHtml).toContain(">on<");

    const offHtml = renderToString(
      <Toggle checked={false} onChange={() => undefined} />,
    );
    expect(offHtml).toContain(">off<");

    const custom = renderToString(
      <Toggle
        checked={true}
        onChange={() => undefined}
        rightLabel="enabled"
      />,
    );
    expect(custom).toContain(">enabled<");
  });

  it("uses ariaLabel when provided, falling back to label", () => {
    const explicit = renderToString(
      <Toggle
        checked={false}
        onChange={() => undefined}
        ariaLabel="Toggle ken_burns"
      />,
    );
    expect(explicit).toContain('aria-label="Toggle ken_burns"');

    const fromLabel = renderToString(
      <Toggle
        checked={false}
        onChange={() => undefined}
        label="Ken Burns"
      />,
    );
    expect(fromLabel).toContain('aria-label="Ken Burns"');
  });

  it("dims the wrapper when disabled", () => {
    const html = renderToString(
      <Toggle checked={false} onChange={() => undefined} disabled />,
    );
    expect(html).toContain("opacity-50");
  });

  it("renders the sliding thumb on the right when checked, left when unchecked", () => {
    const on = renderToString(
      <Toggle checked={true} onChange={() => undefined} />,
    );
    expect(on).toContain("translate-x-4");

    const off = renderToString(
      <Toggle checked={false} onChange={() => undefined} />,
    );
    expect(off).toContain("translate-x-0.5");
  });
});
