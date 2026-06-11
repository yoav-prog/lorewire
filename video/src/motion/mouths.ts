// Mouth shape library for the MouthSwap motion beat. Five hand-drawn SVG
// paths, each a stylized lip shape. Designed to read at small sizes (~28 px
// wide on the 1080-wide composition) and drop in over a mouth-removed
// character portrait at a known anchor point.
//
// The viewBox is 100x60 — each path draws within that box centered on
// (50, 30), so the consumer can scale uniformly without per-shape positioning.

export type MouthShape = "closed" | "ah" | "ee" | "oh" | "mm";

interface MouthRender {
  // SVG fragment that lives inside an <svg viewBox="0 0 100 60"> in the
  // MouthSwap renderer. Each shape uses two paths: an outer dark line for
  // the lip outline, and an inner darker fill for the open mouth interior.
  paths: { d: string; fill: string; stroke?: string; strokeWidth?: number }[];
}

// Color tokens — kept here so they match the doodle ink aesthetic the
// scenes use. Skin-tone neutral lip outline, almost-black mouth interior.
const LIP_OUTLINE = "#5b3a2a";
const MOUTH_INTERIOR = "#1f0e0a";
const TEETH = "#f6efe2";

export const MOUTH_SHAPES: Record<MouthShape, MouthRender> = {
  // Resting / pause mouth — slight curve, no opening visible.
  closed: {
    paths: [
      {
        d: "M 22 32 Q 50 36 78 32",
        fill: "none",
        stroke: LIP_OUTLINE,
        strokeWidth: 4,
      },
    ],
  },
  // Open vowel like "ah" — wide oval, teeth peek.
  ah: {
    paths: [
      {
        d: "M 22 28 Q 50 18 78 28 Q 78 46 50 50 Q 22 46 22 28 Z",
        fill: MOUTH_INTERIOR,
        stroke: LIP_OUTLINE,
        strokeWidth: 3,
      },
      {
        d: "M 30 28 Q 50 22 70 28 Q 70 34 50 32 Q 30 34 30 28 Z",
        fill: TEETH,
      },
    ],
  },
  // "ee" — wide horizontal smile, teeth showing.
  ee: {
    paths: [
      {
        d: "M 18 30 Q 50 22 82 30 Q 82 40 50 42 Q 18 40 18 30 Z",
        fill: MOUTH_INTERIOR,
        stroke: LIP_OUTLINE,
        strokeWidth: 3,
      },
      {
        d: "M 22 28 Q 50 24 78 28 Q 78 34 50 34 Q 22 34 22 28 Z",
        fill: TEETH,
      },
    ],
  },
  // "oh" — round opening.
  oh: {
    paths: [
      {
        d: "M 38 24 Q 50 18 62 24 Q 68 30 62 42 Q 50 48 38 42 Q 32 30 38 24 Z",
        fill: MOUTH_INTERIOR,
        stroke: LIP_OUTLINE,
        strokeWidth: 3,
      },
    ],
  },
  // "mm" — pursed closed lips, thicker line.
  mm: {
    paths: [
      {
        d: "M 24 32 Q 50 34 76 32",
        fill: "none",
        stroke: LIP_OUTLINE,
        strokeWidth: 5,
      },
    ],
  },
};

// Convenience ordered cycle for the lip-flap loop during voiced segments.
// "ah", "ee", "oh" alternate so consecutive frames don't repeat.
export const OPEN_CYCLE: MouthShape[] = ["ah", "ee", "oh"];
