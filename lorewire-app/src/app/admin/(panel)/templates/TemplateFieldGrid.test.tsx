// @vitest-environment happy-dom

// TemplateFieldGrid tests. The grid wraps the Phase A control set into
// a per-tier override form for the Caption Templates page. The contract
// these tests pin:
//   - every field in the section list renders inside the grid
//   - a global-scope grid never shows the Override/Inherit toggle
//   - a cat/story-scope grid shows Inherit for empty values and
//     Override for filled values
//   - hidden inputs carry the form name `caption.{bare}`; their value
//     is empty when inheriting and the override value when overriding
//   - the disabled state turns off the control while inheriting

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import {
  TemplateFieldGrid,
  type FieldDef,
  type SectionDef,
} from "./TemplateFieldGrid";

const SECTIONS: SectionDef[] = [
  {
    title: "Sample section",
    fields: [
      {
        bare: "position_y",
        label: "Position Y",
        kind: "slider",
        min: 0,
        max: 1,
        step: 0.01,
      } satisfies FieldDef,
      {
        bare: "color",
        label: "Word color",
        kind: "color",
      } satisfies FieldDef,
      {
        bare: "entry_effect",
        label: "Entry effect",
        kind: "chip",
        options: [
          { id: "none", label: "None" },
          { id: "fade", label: "Fade" },
        ],
      } satisfies FieldDef,
    ],
  },
];

const VALUES_FULL: Record<string, string> = {
  position_y: "0.6",
  color: "#facc15",
  entry_effect: "fade",
};

const VALUES_EMPTY: Record<string, string> = {
  position_y: "",
  color: "",
  entry_effect: "",
};

const PLACEHOLDERS: Record<string, string> = {
  position_y: "0.68",
  color: "#0f172a",
  entry_effect: "fade",
};

describe("TemplateFieldGrid", () => {
  it("renders one card per field with the field's label", () => {
    const html = renderToString(
      <TemplateFieldGrid
        sections={SECTIONS}
        values={VALUES_FULL}
        placeholders={PLACEHOLDERS}
        scope="global"
      />,
    );
    expect(html).toContain('data-field="position_y"');
    expect(html).toContain('data-field="color"');
    expect(html).toContain('data-field="entry_effect"');
    expect(html).toContain("Position Y");
    expect(html).toContain("Word color");
    expect(html).toContain("Entry effect");
  });

  it("does not show the Override/Inherit toggle at global scope", () => {
    const html = renderToString(
      <TemplateFieldGrid
        sections={SECTIONS}
        values={VALUES_FULL}
        placeholders={PLACEHOLDERS}
        scope="global"
      />,
    );
    expect(html).not.toContain("Inherit");
    expect(html).not.toContain("Override");
  });

  it("shows Inherit for empty values at cat scope", () => {
    const html = renderToString(
      <TemplateFieldGrid
        sections={SECTIONS}
        values={VALUES_EMPTY}
        placeholders={PLACEHOLDERS}
        scope="cat"
      />,
    );
    expect(html).toContain("Inherit");
    expect(html).toContain("Inherits ·");
  });

  it("shows Override for filled values at story scope", () => {
    const html = renderToString(
      <TemplateFieldGrid
        sections={SECTIONS}
        values={VALUES_FULL}
        placeholders={PLACEHOLDERS}
        scope="story"
      />,
    );
    expect(html).toContain("Override");
    expect(html).toContain("Override ·");
  });

  it("emits a hidden input per field with name caption.{bare}", () => {
    const html = renderToString(
      <TemplateFieldGrid
        sections={SECTIONS}
        values={VALUES_FULL}
        placeholders={PLACEHOLDERS}
        scope="global"
      />,
    );
    expect(html).toContain('name="caption.position_y"');
    expect(html).toContain('name="caption.color"');
    expect(html).toContain('name="caption.entry_effect"');
  });

  it("posts an empty hidden value when the field is inheriting", () => {
    const html = renderToString(
      <TemplateFieldGrid
        sections={SECTIONS}
        values={VALUES_EMPTY}
        placeholders={PLACEHOLDERS}
        scope="cat"
      />,
    );
    // Each hidden input for a caption.* field should carry value="" so
    // saveCaptionTemplateAction clears the override at this tier.
    expect(html).toMatch(
      /name="caption\.position_y"[^>]*value=""|value=""[^>]*name="caption\.position_y"/,
    );
    expect(html).toMatch(
      /name="caption\.color"[^>]*value=""|value=""[^>]*name="caption\.color"/,
    );
    expect(html).toMatch(
      /name="caption\.entry_effect"[^>]*value=""|value=""[^>]*name="caption\.entry_effect"/,
    );
  });

  it("posts the override value when filled", () => {
    const html = renderToString(
      <TemplateFieldGrid
        sections={SECTIONS}
        values={VALUES_FULL}
        placeholders={PLACEHOLDERS}
        scope="story"
      />,
    );
    expect(html).toMatch(
      /name="caption\.position_y"[^>]*value="0\.6"|value="0\.6"[^>]*name="caption\.position_y"/,
    );
    expect(html).toMatch(
      /name="caption\.color"[^>]*value="#facc15"|value="#facc15"[^>]*name="caption\.color"/,
    );
  });
});
