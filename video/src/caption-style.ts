// Pure helpers for the Doodle caption renderer. Ported from yt-studio's
// _reference/youtubestudio/src/remotion/doodle-caption-style.ts with the same
// visual contract (yellow comic-bold, dark outline, karaoke highlight) but
// without the CMS override layer (no captions_config flowing in from the DB).
// All defaults are the values yt-studio shipped after their 2026-06-04 pass.

export interface ResolvedDoodleCaptionStyle {
  fontWeight: number;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  textTransform: "uppercase";
  letterSpacing: number;
  lineHeight: number;
  positionY: number;
  paddingX: number;
  activeWordColor: string;
  spokenWordColor: string;
}

export const DOODLE_CAPTION_STYLE: ResolvedDoodleCaptionStyle = {
  fontWeight: 900,
  color: "#facc15",
  outlineColor: "#0f172a",
  outlineWidth: 6,
  textTransform: "uppercase",
  letterSpacing: -0.5,
  lineHeight: 1.05,
  positionY: 0.55,
  paddingX: 64,
  activeWordColor: "#ffffff",
  spokenWordColor: "rgba(250, 204, 21, 0.45)",
};

// Optional fields from the admin caption template. Snake-case keys match the
// settings.key names + the Python resolver's output; resolveCaptionTemplate
// translates them into the camelCase ResolvedDoodleCaptionStyle shape the
// composition's render path uses. Anything missing falls back to the default
// above so existing renders are byte-identical when the admin hasn't touched
// the editor.
export interface CaptionTemplateInput {
  position_y?: number;
  size_scale?: number;
  padding_x?: number;
  text_transform?: "uppercase" | "none" | "lowercase";
  letter_spacing?: number;
  line_height?: number;
  font_weight?: number;
  color?: string;
  outline_color?: string;
  outline_width?: number;
  active_word_color?: string;
  spoken_word_color?: string;
  // entry_effect + word_highlight ride through to the composition but the
  // resolved style type below doesn't include them yet — DoodleCaptionChunk
  // reads them from the template directly because they affect render
  // structure, not just style values.
  entry_effect?: "none" | "fade" | "pop" | "slide-up";
  word_highlight?: "none" | "karaoke" | "color" | "scale" | "background";
}

export interface ResolvedTemplate extends ResolvedDoodleCaptionStyle {
  entryEffect: "none" | "fade" | "pop" | "slide-up";
  wordHighlight: "none" | "karaoke" | "color" | "scale" | "background";
  sizeScale: number;
}

const _isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function resolveCaptionTemplate(
  input: CaptionTemplateInput | undefined,
): ResolvedTemplate {
  const i = input ?? {};
  const d = DOODLE_CAPTION_STYLE;
  return {
    fontWeight: _isNumber(i.font_weight) ? i.font_weight : d.fontWeight,
    color: i.color ?? d.color,
    outlineColor: i.outline_color ?? d.outlineColor,
    outlineWidth: _isNumber(i.outline_width) ? i.outline_width : d.outlineWidth,
    textTransform: i.text_transform ?? d.textTransform,
    letterSpacing: _isNumber(i.letter_spacing) ? i.letter_spacing : d.letterSpacing,
    lineHeight: _isNumber(i.line_height) ? i.line_height : d.lineHeight,
    positionY: _isNumber(i.position_y) ? i.position_y : d.positionY,
    paddingX: _isNumber(i.padding_x) ? i.padding_x : d.paddingX,
    activeWordColor: i.active_word_color ?? d.activeWordColor,
    spokenWordColor: i.spoken_word_color ?? d.spokenWordColor,
    entryEffect: i.entry_effect ?? "fade",
    wordHighlight: i.word_highlight ?? "karaoke",
    sizeScale: _isNumber(i.size_scale) ? i.size_scale : 1,
  };
}

// Each caption chunk fades in over 80 ms and out over 80 ms; the
// composition adds these to the karaoke effect so the band feels alive
// without distracting from the per-word highlight.
export const CHUNK_FADE_MS = 80;

// Title chip at the top is visible for the hook (first 1.2 s) and fades
// out over 0.6 s after. Keeps it out of the way of the caption line.
export const TITLE_VISIBLE_MS = 1200;
export const TITLE_FADE_MS = 600;
