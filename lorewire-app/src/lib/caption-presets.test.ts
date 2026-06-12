// Pins the built-in caption preset contract: every preset covers every
// CaptionStyleField, every hex color is well-formed, every numeric is
// a finite number, and findBuiltInCaptionPreset rejects unknown ids.
//
// Drift any of these and the apply action's invariants stop holding —
// silent half-applied styles are the kind of regression that wastes
// hours.

import { describe, expect, it } from "vitest";
import {
  BUILT_IN_CAPTION_PRESETS,
  findBuiltInCaptionPreset,
} from "@/lib/caption-presets";
import { CAPTION_STYLE_FIELDS } from "@/lib/caption-style";

const HEX_RE = /^#[0-9a-f]{3,8}$/i;

describe("BUILT_IN_CAPTION_PRESETS", () => {
  it("ships exactly the six approved presets", () => {
    expect(BUILT_IN_CAPTION_PRESETS).toHaveLength(6);
    const ids = BUILT_IN_CAPTION_PRESETS.map((p) => p.id);
    expect(ids).toEqual([
      "mrbeast-bold",
      "karaoke-yellow",
      "clean-white",
      "subtle-gray",
      "tiktok-glow",
      "tutorial-caption",
    ]);
  });

  it("every preset covers every CaptionStyleField (no gaps)", () => {
    for (const preset of BUILT_IN_CAPTION_PRESETS) {
      for (const field of CAPTION_STYLE_FIELDS) {
        expect(
          preset.values[field],
          `${preset.id} missing field ${field}`,
        ).toBeDefined();
        expect(typeof preset.values[field]).toBe("string");
      }
    }
  });

  it("every preset's color fields are valid hex", () => {
    for (const preset of BUILT_IN_CAPTION_PRESETS) {
      expect(preset.values.color, `${preset.id}.color`).toMatch(HEX_RE);
      expect(
        preset.values.active_word_color,
        `${preset.id}.active_word_color`,
      ).toMatch(HEX_RE);
      expect(
        preset.values.outline_color,
        `${preset.id}.outline_color`,
      ).toMatch(HEX_RE);
      // spoken_word_color allows rgba; just assert it's non-empty.
      expect(preset.values.spoken_word_color.length).toBeGreaterThan(0);
    }
  });

  it("every preset's numeric fields parse to finite numbers", () => {
    const numericFields = [
      "position_y",
      "size_scale",
      "padding_x",
      "font_weight",
      "letter_spacing",
      "line_height",
      "outline_width",
    ] as const;
    for (const preset of BUILT_IN_CAPTION_PRESETS) {
      for (const field of numericFields) {
        const n = parseFloat(preset.values[field]);
        expect(
          Number.isFinite(n),
          `${preset.id}.${field} = ${preset.values[field]} is not finite`,
        ).toBe(true);
      }
    }
  });

  it("every preset's enumerated fields use known values", () => {
    const allowed = {
      text_transform: ["uppercase", "none", "lowercase"],
      entry_effect: ["none", "fade", "pop", "slide-up"],
      word_highlight: ["none", "karaoke", "color", "scale", "background"],
    };
    for (const preset of BUILT_IN_CAPTION_PRESETS) {
      expect(allowed.text_transform).toContain(preset.values.text_transform);
      expect(allowed.entry_effect).toContain(preset.values.entry_effect);
      expect(allowed.word_highlight).toContain(preset.values.word_highlight);
    }
  });

  it("every preset has a non-empty name + tagline", () => {
    for (const preset of BUILT_IN_CAPTION_PRESETS) {
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.tagline.length).toBeGreaterThan(0);
    }
  });

  it("preset ids are unique", () => {
    const ids = BUILT_IN_CAPTION_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("findBuiltInCaptionPreset", () => {
  it("returns the matching preset for a known id", () => {
    const found = findBuiltInCaptionPreset("mrbeast-bold");
    expect(found?.id).toBe("mrbeast-bold");
    expect(found?.name).toBe("MrBeast bold");
  });

  it("returns undefined for an unknown id", () => {
    expect(findBuiltInCaptionPreset("not-a-preset")).toBeUndefined();
  });

  it("returns undefined for an empty id (defensive)", () => {
    expect(findBuiltInCaptionPreset("")).toBeUndefined();
  });
});
