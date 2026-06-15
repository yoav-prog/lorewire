// Tests for the ShortConfig.caption_style → CaptionStyleProps adapter
// that feeds the editor preview.

import { describe, expect, it } from "vitest";
import { shortCaptionStyleToProps } from "@/lib/short-caption-style-to-props";
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
