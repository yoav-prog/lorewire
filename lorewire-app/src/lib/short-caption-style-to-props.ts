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
