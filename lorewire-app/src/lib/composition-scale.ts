// Composition scaling helper — MIRROR of `video/src/scale.ts`.
//
// The renderer-side module ships a React hook (`useCompositionScale`) that
// the composition uses; the admin side mostly cares about the pure-data
// `computeScale` for the editor preview and any future tests. Duplicated
// rather than cross-imported because /video/ pulls Remotion runtime into
// its module — same back-and-forth as `aspect.ts` and `video-config.ts`.
//
// The two files MUST stay in sync. `composition-scale.test.ts` runs a
// parity assertion against the renderer copy so an accidental drift
// fails CI loudly.

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
  /** Min(ratioW, ratioH) — multiplier for FIXED-ASPECT overlays
   *  (square prop cards, the talking-head bust, corner scribble box).
   *  Without this, scaling by width alone makes a 320x320 card balloon
   *  to 569x569 on landscape (×1.78 wider canvas) — half the canvas
   *  height. Using the smaller ratio keeps the overlay proportional to
   *  the smaller axis so it always fits both. */
  ratioMin: number;
  /** Map a base-px horizontal value to the current canvas. */
  scaleW: (px: number) => number;
  /** Map a base-px vertical value to the current canvas. */
  scaleH: (px: number) => number;
  /** Map a base-px value to the smaller axis — for fixed-aspect overlays. */
  scaleMin: (px: number) => number;
}

/** Pure scaling helper — given canvas dims, returns the multipliers. */
export function computeScale(width: number, height: number): CompositionScale {
  const ratioW = width / BASE_WIDTH;
  const ratioH = height / BASE_HEIGHT;
  const ratioMin = Math.min(ratioW, ratioH);
  return {
    ratioW,
    ratioH,
    ratioMin,
    scaleW: (px) => px * ratioW,
    scaleH: (px) => px * ratioH,
    scaleMin: (px) => px * ratioMin,
  };
}
