// Tests for the ShortConfig.caption_style → CaptionStyleProps adapter
// that feeds the editor preview.

import { describe, expect, it } from "vitest";
import {
  shortCaptionStyleToProps,
  shortCaptionStyleToRenderTemplate,
} from "@/lib/short-caption-style-to-props";
import {
  CURRENT_SHORT_CONFIG_VERSION,
  type ShortConfig,
} from "@/lib/short-config";

function baseShort(over: Partial<ShortConfig> = {}): ShortConfig {
  return {
    config_version: CURRENT_SHORT_CONFIG_VERSION,
    doodle_frames: [],
    captions: [],
    ...over,
  };
}

describe("shortCaptionStyleToProps", () => {
  it("returns null when caption_style is unset", () => {
    expect(shortCaptionStyleToProps(baseShort())).toBeNull();
  });

  it("returns null when caption_style is set but empty", () => {
    expect(
      shortCaptionStyleToProps(baseShort({ caption_style: {} })),
    ).toBeNull();
  });

  it("fills in defaults for fields that aren't overridden", () => {
    const props = shortCaptionStyleToProps(
      baseShort({ caption_style: { color: "#ff0000" } }),
    );
    expect(props).not.toBeNull();
    expect(props!.color).toBe("#ff0000");
    // The other fields fall back to defaults — locked here so a future
    // default shift breaks loudly.
    expect(props!.word_highlight).toBe("karaoke");
    expect(props!.entry_effect).toBe("fade");
    expect(props!.font_weight).toBe(900);
  });

  it("parses numeric fields from strings", () => {
    const props = shortCaptionStyleToProps(
      baseShort({
        caption_style: {
          position_y: "0.72",
          size_scale: "1.4",
          padding_x: "32",
          font_weight: "600",
          letter_spacing: "1",
          line_height: "1.3",
          outline_width: "10",
        },
      }),
    );
    expect(props!.position_y).toBe(0.72);
    expect(props!.size_scale).toBe(1.4);
    expect(props!.padding_x).toBe(32);
    expect(props!.font_weight).toBe(600);
    expect(props!.letter_spacing).toBe(1);
    expect(props!.line_height).toBe(1.3);
    expect(props!.outline_width).toBe(10);
  });

  it("falls back to defaults on unparseable numeric strings", () => {
    const props = shortCaptionStyleToProps(
      baseShort({ caption_style: { position_y: "not-a-number" } }),
    );
    expect(props!.position_y).toBe(0.55);
  });

  it("rejects unknown enum values and uses defaults", () => {
    const props = shortCaptionStyleToProps(
      baseShort({
        caption_style: {
          word_highlight: "rainbow",
          entry_effect: "explode",
          text_transform: "diagonal",
        },
      }),
    );
    expect(props!.word_highlight).toBe("karaoke");
    expect(props!.entry_effect).toBe("fade");
    expect(props!.text_transform).toBe("uppercase");
  });
});

describe("shortCaptionStyleToRenderTemplate", () => {
  it("returns an empty object when caption_style is undefined", () => {
    expect(shortCaptionStyleToRenderTemplate(undefined)).toEqual({});
  });

  it("coerces numeric fields to numbers so resolveCaptionTemplate accepts them", () => {
    const out = shortCaptionStyleToRenderTemplate({
      position_y: "0.7",
      size_scale: "1.2",
      padding_x: "48",
      font_weight: "700",
      letter_spacing: "1.5",
      line_height: "1.2",
      outline_width: "8",
    });
    expect(out.position_y).toBe(0.7);
    expect(out.size_scale).toBe(1.2);
    expect(out.padding_x).toBe(48);
    expect(out.font_weight).toBe(700);
    expect(out.letter_spacing).toBe(1.5);
    expect(out.line_height).toBe(1.2);
    expect(out.outline_width).toBe(8);
  });

  it("passes string fields through unchanged", () => {
    const out = shortCaptionStyleToRenderTemplate({
      color: "#facc15",
      outline_color: "#0f172a",
      active_word_color: "#ffffff",
      spoken_word_color: "rgba(0,0,0,0.5)",
      text_transform: "uppercase",
      word_highlight: "karaoke",
      entry_effect: "pop",
    });
    expect(out.color).toBe("#facc15");
    expect(out.outline_color).toBe("#0f172a");
    expect(out.active_word_color).toBe("#ffffff");
    expect(out.spoken_word_color).toBe("rgba(0,0,0,0.5)");
    expect(out.text_transform).toBe("uppercase");
    expect(out.word_highlight).toBe("karaoke");
    expect(out.entry_effect).toBe("pop");
  });

  it("omits unparseable numerics so the baseline value stays in charge", () => {
    const out = shortCaptionStyleToRenderTemplate({
      position_y: "not-a-number",
      color: "#ff0000",
    });
    expect(out).not.toHaveProperty("position_y");
    expect(out.color).toBe("#ff0000");
  });

  it("omits empty-string fields so a cleared override doesn't stomp the baseline", () => {
    const out = shortCaptionStyleToRenderTemplate({
      color: "",
      position_y: "",
      word_highlight: "scale",
    });
    expect(out).not.toHaveProperty("color");
    expect(out).not.toHaveProperty("position_y");
    expect(out.word_highlight).toBe("scale");
  });

  it("drops unknown keys silently", () => {
    const out = shortCaptionStyleToRenderTemplate({
      color: "#abcdef",
      mystery_field: "ignored",
    } as Record<string, string>);
    expect(out.color).toBe("#abcdef");
    expect(out).not.toHaveProperty("mystery_field");
  });
});
