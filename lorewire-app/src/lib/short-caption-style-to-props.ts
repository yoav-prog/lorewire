// Adapter: ShortConfig.caption_style (sparse Partial<Record<field, string>>)
// → CaptionStyleProps (typed, complete) for the editor preview's
// PreviewComposition.
//
// The renderer's PreviewComposition expects TYPED values (number for
// numeric fields, enum for text_transform / entry_effect / word_highlight).
// The editor stores STRINGS (matches the caption-style.ts settings-resolver
// chain — every tier reads/writes strings and the composition parses at the
// boundary). This adapter does the parse + fills in defaults for unset
// fields so the preview always has a complete prop shape.
//
// Returns null when caption_style is unset OR contains no usable fields,
// so the caller can skip passing the prop entirely (PreviewComposition's
// own hardcoded defaults kick in then).
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md (caption styles).

import type { ShortConfig } from "@/lib/short-config";

// Typed shape that mirrors components/video-preview/PreviewComposition.tsx's
// CaptionStyleProps. Duplicated here to keep this module client-safe (the
// PreviewComposition module imports Remotion runtime).
export interface ShortCaptionStyleProps {
  position_y: number;
  size_scale: number;
  padding_x: number;
  text_transform: "uppercase" | "none" | "lowercase";
  font_weight: number;
  letter_spacing: number;
  line_height: number;
  color: string;
  active_word_color: string;
  spoken_word_color: string;
  outline_color: string;
  outline_width: number;
  entry_effect: "none" | "fade" | "pop" | "slide-up";
  word_highlight: "none" | "karaoke" | "color" | "scale" | "background";
}

// Mirror of caption-style.ts CAPTION_DEFAULTS. Kept locally so this module
// stays importable from client components (caption-style.ts is server-only).
const DEFAULTS: ShortCaptionStyleProps = {
  position_y: 0.55,
  size_scale: 1,
  padding_x: 64,
  text_transform: "uppercase",
  font_weight: 900,
  letter_spacing: -0.5,
  line_height: 1.05,
  color: "#facc15",
  active_word_color: "#ffffff",
  spoken_word_color: "rgba(250, 204, 21, 0.45)",
  outline_color: "#0f172a",
  outline_width: 6,
  entry_effect: "fade",
  word_highlight: "karaoke",
};

const TEXT_TRANSFORMS = new Set(["uppercase", "none", "lowercase"]);
const ENTRY_EFFECTS = new Set(["none", "fade", "pop", "slide-up"]);
const WORD_HIGHLIGHTS = new Set([
  "none",
  "karaoke",
  "color",
  "scale",
  "background",
]);

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

export function shortCaptionStyleToProps(
  config: ShortConfig,
): ShortCaptionStyleProps | null {
  const s = config.caption_style;
  if (!s) return null;
  // If every field is empty/undefined, skip — let the composition use its
  // own defaults rather than re-emitting our defaults verbatim (cheaper
  // re-renders).
  const hasAny = Object.values(s).some(
    (v) => typeof v === "string" && v.length > 0,
  );
  if (!hasAny) return null;
  return {
    position_y: num(s.position_y, DEFAULTS.position_y),
    size_scale: num(s.size_scale, DEFAULTS.size_scale),
    padding_x: num(s.padding_x, DEFAULTS.padding_x),
    text_transform:
      s.text_transform && TEXT_TRANSFORMS.has(s.text_transform)
        ? (s.text_transform as ShortCaptionStyleProps["text_transform"])
        : DEFAULTS.text_transform,
    font_weight: num(s.font_weight, DEFAULTS.font_weight),
    letter_spacing: num(s.letter_spacing, DEFAULTS.letter_spacing),
    line_height: num(s.line_height, DEFAULTS.line_height),
    color: s.color || DEFAULTS.color,
    active_word_color: s.active_word_color || DEFAULTS.active_word_color,
    spoken_word_color: s.spoken_word_color || DEFAULTS.spoken_word_color,
    outline_color: s.outline_color || DEFAULTS.outline_color,
    outline_width: num(s.outline_width, DEFAULTS.outline_width),
    entry_effect:
      s.entry_effect && ENTRY_EFFECTS.has(s.entry_effect)
        ? (s.entry_effect as ShortCaptionStyleProps["entry_effect"])
        : DEFAULTS.entry_effect,
    word_highlight:
      s.word_highlight && WORD_HIGHLIGHTS.has(s.word_highlight)
        ? (s.word_highlight as ShortCaptionStyleProps["word_highlight"])
        : DEFAULTS.word_highlight,
  };
}

// Coerce a baseline render's caption_template (the bag of typed values the
// Python pipeline writes onto short_renders.props.caption_template) into a
// CaptionStyleProps that matches what the renderer would use. Missing or
// malformed fields fall through to DEFAULTS. Same field set + names as the
// Python `_CAPTION_DEFAULTS` in pipeline/video.py — verified against the
// snake_case keys the resolver writes.
//
// This is the bridge between "what the renderer baked into the last MP4"
// and "what the preview should show" — the editor preview should match the
// renderer's actual style baseline, not its own hardcoded TS defaults
// (which is why a `caption.color = #ff0000` settings override produced a
// red render but a yellow preview pre-fix).
export function baselineCaptionTemplateToProps(
  template: Record<string, unknown> | null | undefined,
): ShortCaptionStyleProps {
  if (!template) return { ...DEFAULTS };
  const t = template;
  const pickNum = (key: keyof ShortCaptionStyleProps, fallback: number): number => {
    const v = t[key];
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };
  const pickStr = (key: keyof ShortCaptionStyleProps, fallback: string): string => {
    const v = t[key];
    return typeof v === "string" && v.length > 0 ? v : fallback;
  };
  return {
    position_y: pickNum("position_y", DEFAULTS.position_y),
    size_scale: pickNum("size_scale", DEFAULTS.size_scale),
    padding_x: pickNum("padding_x", DEFAULTS.padding_x),
    text_transform:
      typeof t.text_transform === "string" && TEXT_TRANSFORMS.has(t.text_transform)
        ? (t.text_transform as ShortCaptionStyleProps["text_transform"])
        : DEFAULTS.text_transform,
    font_weight: pickNum("font_weight", DEFAULTS.font_weight),
    letter_spacing: pickNum("letter_spacing", DEFAULTS.letter_spacing),
    line_height: pickNum("line_height", DEFAULTS.line_height),
    color: pickStr("color", DEFAULTS.color),
    active_word_color: pickStr("active_word_color", DEFAULTS.active_word_color),
    spoken_word_color: pickStr("spoken_word_color", DEFAULTS.spoken_word_color),
    outline_color: pickStr("outline_color", DEFAULTS.outline_color),
    outline_width: pickNum("outline_width", DEFAULTS.outline_width),
    entry_effect:
      typeof t.entry_effect === "string" && ENTRY_EFFECTS.has(t.entry_effect)
        ? (t.entry_effect as ShortCaptionStyleProps["entry_effect"])
        : DEFAULTS.entry_effect,
    word_highlight:
      typeof t.word_highlight === "string" && WORD_HIGHLIGHTS.has(t.word_highlight)
        ? (t.word_highlight as ShortCaptionStyleProps["word_highlight"])
        : DEFAULTS.word_highlight,
  };
}

// Layered resolver for the editor preview. Builds the COMPLETE caption
// style the preview should render:
//   1. DEFAULTS (yellow, the TS hardcoded floor)
//   2. baseline render's caption_template (what the renderer last used —
//      this is where DB-level overrides like `caption.color = #ff0000`
//      enter the preview's vocabulary)
//   3. short_config.caption_style overrides (the editor's unsaved edits)
//
// Returns a complete CaptionStyleProps so the preview composition can use
// it directly without falling through to its own hardcoded defaults.
// Pre-fix the preview was step 1 + step 3 only, so step 2's settings-
// driven choices (red captions baked into the baseline) never reached the
// preview and the editor lied about what the next render would look like.
export function resolveShortCaptionStyle(
  config: ShortConfig,
  baselineCaptionTemplate?: Record<string, unknown> | null,
): ShortCaptionStyleProps {
  const baseline = baselineCaptionTemplateToProps(baselineCaptionTemplate);
  const overrides = config.caption_style;
  if (!overrides) return baseline;
  const numField = (key: keyof ShortCaptionStyleProps): number => {
    const raw = (overrides as Record<string, string | undefined>)[key];
    if (typeof raw !== "string" || raw.length === 0) return baseline[key] as number;
    const v = Number(raw);
    return Number.isFinite(v) ? v : (baseline[key] as number);
  };
  const strField = (key: keyof ShortCaptionStyleProps): string => {
    const raw = (overrides as Record<string, string | undefined>)[key];
    if (typeof raw !== "string" || raw.length === 0) return baseline[key] as string;
    return raw;
  };
  return {
    position_y: numField("position_y"),
    size_scale: numField("size_scale"),
    padding_x: numField("padding_x"),
    text_transform:
      overrides.text_transform && TEXT_TRANSFORMS.has(overrides.text_transform)
        ? (overrides.text_transform as ShortCaptionStyleProps["text_transform"])
        : baseline.text_transform,
    font_weight: numField("font_weight"),
    letter_spacing: numField("letter_spacing"),
    line_height: numField("line_height"),
    color: strField("color"),
    active_word_color: strField("active_word_color"),
    spoken_word_color: strField("spoken_word_color"),
    outline_color: strField("outline_color"),
    outline_width: numField("outline_width"),
    entry_effect:
      overrides.entry_effect && ENTRY_EFFECTS.has(overrides.entry_effect)
        ? (overrides.entry_effect as ShortCaptionStyleProps["entry_effect"])
        : baseline.entry_effect,
    word_highlight:
      overrides.word_highlight && WORD_HIGHLIGHTS.has(overrides.word_highlight)
        ? (overrides.word_highlight as ShortCaptionStyleProps["word_highlight"])
        : baseline.word_highlight,
  };
}

// Sparse typed coercion for the render path. The editor persists every
// caption_style field as a STRING (matches the settings-resolver shape),
// but the Remotion renderer's resolveCaptionTemplate rejects string-typed
// numerics (font_weight, position_y, padding_x, letter_spacing, line_height,
// outline_width, size_scale) via an _isNumber guard and silently falls
// back to defaults. Spreading the raw caption_style map onto
// caption_template therefore drops every numeric override — only the
// string-shaped fields (color, outline_color, text_transform, word_highlight,
// entry_effect) survive the merge.
//
// This helper coerces each numeric field to a number BEFORE the merge so
// the renderer receives the type it expects. Sparse: missing or empty
// fields are omitted so the baseline caption_template (from the
// settings-resolver) stays in charge of anything the admin didn't touch.
//
// Returns an empty object when caption_style is undefined or fully empty;
// callers can short-circuit on `Object.keys(out).length === 0`.
export function shortCaptionStyleToRenderTemplate(
  caption_style: { [key: string]: string | undefined } | undefined,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!caption_style) return out;
  const numericFields = [
    "position_y",
    "size_scale",
    "padding_x",
    "font_weight",
    "letter_spacing",
    "line_height",
    "outline_width",
  ] as const;
  const stringFields = [
    "text_transform",
    "color",
    "active_word_color",
    "spoken_word_color",
    "outline_color",
    "entry_effect",
    "word_highlight",
  ] as const;
  for (const f of numericFields) {
    const raw = caption_style[f];
    if (typeof raw !== "string" || raw.length === 0) continue;
    const v = Number(raw);
    if (Number.isFinite(v)) out[f] = v;
  }
  for (const f of stringFields) {
    const raw = caption_style[f];
    if (typeof raw === "string" && raw.length > 0) out[f] = raw;
  }
  return out;
}
