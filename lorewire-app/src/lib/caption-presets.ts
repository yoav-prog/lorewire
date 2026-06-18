// Built-in caption style presets. Phase B of the admin UI overhaul
// (_plans/2026-06-12-admin-ui-overhaul.md). Each preset is a full
// snapshot of all 14 CaptionStyleField values — applying a preset
// writes every field's story-scope override in one batch.
//
// Names approved 2026-06-12 (Yoav): MrBeast bold, Karaoke yellow,
// Clean white, Subtle gray, TikTok glow, Tutorial caption.
//
// Each preset is hand-tuned, not auto-generated. The "preview" is a
// short style descriptor the UI renders in the chip; the actual
// visual happens when the values land in the live Remotion preview.

import type { CaptionStyleField } from "@/lib/caption-style";

export type CaptionStyleValues = Record<CaptionStyleField, string>;

export interface CaptionPreset {
  /** Stable id stored in queue rows + URLs. Never localised. */
  id: string;
  /** Display name in the presets row. */
  name: string;
  /** One-line description for the chip tooltip. */
  tagline: string;
  values: CaptionStyleValues;
}

export const BUILT_IN_CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: "mrbeast-bold",
    name: "MrBeast bold",
    tagline: "Yellow + thick black outline, center-bottom, all caps.",
    values: {
      position_y: "0.68",
      size_scale: "1.1",
      padding_x: "48",
      text_transform: "uppercase",
      font_weight: "900",
      letter_spacing: "-0.5",
      line_height: "1.05",
      color: "#facc15",
      active_word_color: "#ffffff",
      spoken_word_color: "rgba(250, 204, 21, 0.45)",
      outline_color: "#0f172a",
      outline_width: "8",
      entry_effect: "pop",
      word_highlight: "karaoke",
    },
  },
  {
    id: "karaoke-yellow",
    name: "Karaoke yellow",
    tagline: "Yellow active word, dim spoken trail, no entry pop.",
    values: {
      position_y: "0.6",
      size_scale: "1",
      padding_x: "64",
      text_transform: "none",
      font_weight: "700",
      letter_spacing: "0",
      line_height: "1.15",
      color: "#ffffff",
      active_word_color: "#facc15",
      spoken_word_color: "rgba(255, 255, 255, 0.35)",
      outline_color: "#0f172a",
      outline_width: "4",
      entry_effect: "fade",
      word_highlight: "karaoke",
    },
  },
  {
    id: "clean-white",
    name: "Clean white",
    tagline: "Plain white, thin outline, lower-third, no highlight.",
    values: {
      position_y: "0.8",
      size_scale: "0.9",
      padding_x: "96",
      text_transform: "none",
      font_weight: "600",
      letter_spacing: "0",
      line_height: "1.2",
      color: "#ffffff",
      active_word_color: "#ffffff",
      spoken_word_color: "#ffffff",
      outline_color: "#0f172a",
      outline_width: "3",
      entry_effect: "fade",
      word_highlight: "none",
    },
  },
  {
    id: "subtle-gray",
    name: "Subtle gray",
    tagline: "Muted gray, small, gentle fade, easy on the eye.",
    values: {
      position_y: "0.85",
      size_scale: "0.8",
      padding_x: "128",
      text_transform: "none",
      font_weight: "500",
      letter_spacing: "0.2",
      line_height: "1.25",
      color: "#cbd5e1",
      active_word_color: "#f8fafc",
      spoken_word_color: "rgba(203, 213, 225, 0.5)",
      outline_color: "#1e293b",
      outline_width: "2",
      entry_effect: "fade",
      word_highlight: "color",
    },
  },
  {
    id: "tiktok-glow",
    name: "TikTok glow",
    tagline: "Orange + slide-up, scale highlight, center stage.",
    values: {
      position_y: "0.5",
      size_scale: "1.15",
      padding_x: "40",
      text_transform: "uppercase",
      font_weight: "800",
      letter_spacing: "-0.5",
      line_height: "1.05",
      color: "#ea580c",
      active_word_color: "#ffffff",
      spoken_word_color: "rgba(234, 88, 12, 0.4)",
      outline_color: "#0f172a",
      outline_width: "6",
      entry_effect: "slide-up",
      word_highlight: "scale",
    },
  },
  {
    id: "tutorial-caption",
    name: "Tutorial caption",
    tagline: "Readable blue on a soft slate background highlight.",
    values: {
      position_y: "0.7",
      size_scale: "0.95",
      padding_x: "80",
      text_transform: "none",
      font_weight: "600",
      letter_spacing: "0",
      line_height: "1.2",
      color: "#0ea5e9",
      active_word_color: "#ffffff",
      spoken_word_color: "rgba(14, 165, 233, 0.35)",
      outline_color: "#0f172a",
      outline_width: "4",
      entry_effect: "fade",
      word_highlight: "background",
    },
  },
];

// Quick lookup by id; rejects ids we don't ship.
const BY_ID = new Map<string, CaptionPreset>(
  BUILT_IN_CAPTION_PRESETS.map((p) => [p.id, p]),
);

export function findBuiltInCaptionPreset(
  id: string,
): CaptionPreset | undefined {
  return BY_ID.get(id);
}

// User-saved presets ride the settings table under this key. JSON-
// encoded array; shape matches CaptionPreset minus the tagline (user
// presets get the user's name as their tagline by default).
export const USER_CAPTION_PRESETS_SETTING_KEY =
  "ui.admin.caption_presets_user";
