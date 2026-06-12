// @vitest-environment happy-dom

// Pins the FieldRow layout primitive's contract: label + optional
// inheritance badge + optional Reset link + the effective-value hint.

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { FieldRow } from "./FieldRow";

describe("FieldRow", () => {
  it("renders the label and child control", () => {
    const html = renderToString(
      <FieldRow label="Position Y">
        <input data-test-child="yes" />
      </FieldRow>,
    );
    expect(html).toContain("Position Y");
    expect(html).toContain('data-test-child="yes"');
    expect(html).toContain('data-testid="field-row"');
  });

  it("renders the inheritance badge when supplied", () => {
    const html = renderToString(
      <FieldRow label="Color" inheritance="default">
        <span />
      </FieldRow>,
    );
    expect(html).toContain("default");
  });

  it("renders the Reset link only when canReset is true", () => {
    const without = renderToString(
      <FieldRow label="Color">
        <span />
      </FieldRow>,
    );
    expect(without).not.toContain("Reset");

    const withReset = renderToString(
      <FieldRow label="Color" canReset onReset={() => undefined}>
        <span />
      </FieldRow>,
    );
    expect(withReset).toContain("Reset");
  });

  it("does NOT render Reset when canReset is true but onReset is missing", () => {
    // Defensive: a bug in the caller shouldn't surface a button that
    // does nothing.
    const html = renderToString(
      <FieldRow label="Color" canReset>
        <span />
      </FieldRow>,
    );
    expect(html).not.toContain("Reset");
  });

  it("renders the effective hint with the inheritance source", () => {
    const html = renderToString(
      <FieldRow label="Color" inheritance="default" effective="#facc15">
        <span />
      </FieldRow>,
    );
    expect(html).toContain("Effective");
    expect(html).toContain("#facc15");
    expect(html).toContain("inherits from");
  });

  it("renders the hint copy when supplied", () => {
    const html = renderToString(
      <FieldRow label="Color" hint="Color of normal caption text">
        <span />
      </FieldRow>,
    );
    expect(html).toContain("Color of normal caption text");
  });
});
