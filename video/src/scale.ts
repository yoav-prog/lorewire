// Composition scaling helper. Phase 1 of
// _plans/2026-06-12-video-aspect-ratio.md.
//
// The DoodleShort composition was authored against a fixed 1080x1920
// portrait canvas, so every "px" value baked into its layout (the title
// chip's `top: 96`, caption `padding_x: 64`, motion-beat insets) is
// calibrated for that baseline. When the canvas changes shape — Phase 0
// added the seam to let calculateMetadata emit 1920x1080 landscape — those
// values would otherwise sit in absolute pixels, which makes the layout
// look weighted toward the top/edges or visually undersized.
//
// `useCompositionScale()` returns two helpers: `scaleW(px)` for values
// that should track the canvas width (font sizes, horizontal padding,
// outline strokes, max widths, square overlay extents) and `scaleH(px)`
// for values that should track the canvas height (top / bottom insets,
// vertical padding). For a portrait render `ratioW` and `ratioH` are both
// 1.0, so every existing pre-Phase-1 value passes through unchanged and
// the rendered MP4 stays byte-identical to before. For landscape they
// become 1.78 and 0.56 respectively.
//
// Pure-thin wrapper over `useVideoConfig()` — no state, no side effects,
// safe to call from any composition child.

import { useVideoConfig } from "remotion";

/** Composition width every base-px value was authored against. */
export const BASE_WIDTH = 1080;
/** Composition height every base-px value was authored against. */
export const BASE_HEIGHT = 1920;

export interface CompositionScale {
  /** Width / BASE_WIDTH — multiplier for "horizontal" px values like
   *  font size, horizontal padding, outline width, maxWidth. */
  ratioW: number;
  /** Height / BASE_HEIGHT — multiplier for "vertical" px values like
   *  top / bottom insets and vertical padding. */
  ratioH: number;
  /** Map a base-px horizontal value to the current canvas. */
  scaleW: (px: number) => number;
  /** Map a base-px vertical value to the current canvas. */
  scaleH: (px: number) => number;
}

/**
 * Hook that reads the current Remotion canvas size and returns the
 * scaling helpers. Identity (1.0 / 1.0) for the legacy 1080x1920
 * portrait composition so back-compat holds bit-for-bit.
 */
export function useCompositionScale(): CompositionScale {
  const { width, height } = useVideoConfig();
  return computeScale(width, height);
}

/** Pure form for unit tests + non-hook contexts. */
export function computeScale(width: number, height: number): CompositionScale {
  const ratioW = width / BASE_WIDTH;
  const ratioH = height / BASE_HEIGHT;
  return {
    ratioW,
    ratioH,
    scaleW: (px) => px * ratioW,
    scaleH: (px) => px * ratioH,
  };
}
