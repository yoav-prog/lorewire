// ScribbleDraw: at the start of each scene window, animates an SVG path
// drawing on over 800ms using stroke-dashoffset interpolation. The path is
// a short hand-doodled curve placed in a corner of the frame so it accents
// the scene rather than competing with the main illustration. Corner
// cycles by sequence index; each scene gets a slightly different curve
// shape derived from the seed.

import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { useCompositionScale } from "../scale";

interface Props {
  enabled: boolean;
  seed: number;
  // Where the scribble origins from in the canvas. Cycles by seed % 4
  // across the four corners; the (px) inset + svg box dims scale by the
  // composition scale helper so 16:9 renders look proportionally right.
}

const DRAW_DURATION_MS = 800;
const STROKE_LENGTH = 800; // upper bound for dasharray; safe over any path we draw

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const CORNERS: Corner[] = ["top-right", "bottom-left", "top-left", "bottom-right"];

// Four short scribbly curves — each ~200 path units, expressed in a 200x200
// SVG viewBox we then place at the chosen corner. Shapes intentionally
// resemble pen flourishes a doodle artist would draw at scene transitions.
const PATHS: string[] = [
  "M 10 100 Q 50 20, 100 80 T 190 60",
  "M 20 180 C 60 40, 150 160, 190 30",
  "M 10 50 Q 80 130, 60 180 T 190 140",
  "M 190 30 C 100 60, 70 160, 30 190",
];

export const ScribbleDraw: React.FC<Props> = ({ enabled, seed }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { scaleW, scaleH, scaleMin } = useCompositionScale();

  if (!enabled) return null;

  const elapsedMs = (frame / fps) * 1000;
  if (elapsedMs < 0 || elapsedMs > DRAW_DURATION_MS + 600) return null;

  const progress = Math.min(1, Math.max(0, elapsedMs / DRAW_DURATION_MS));
  const dashoffset = STROKE_LENGTH * (1 - progress);
  // Fade in over the first 80ms and fade out after the draw finishes (over 600ms).
  const fadeIn = Math.min(1, elapsedMs / 80);
  const fadeOut =
    elapsedMs > DRAW_DURATION_MS
      ? Math.max(0, 1 - (elapsedMs - DRAW_DURATION_MS) / 600)
      : 1;
  const opacity = Math.min(fadeIn, fadeOut);

  const cornerIdx = seed % CORNERS.length;
  const pathIdx = seed % PATHS.length;
  const corner = CORNERS[cornerIdx];
  const d = PATHS[pathIdx];

  return (
    <div
      style={{
        position: "absolute",
        ...positionFor(corner, scaleW, scaleH),
        // Square overlay — use scaleMin so a landscape canvas (wider
        // but shorter than portrait) doesn't balloon the box past the
        // canvas height.
        width: scaleMin(320),
        height: scaleMin(320),
        opacity,
        pointerEvents: "none",
      }}
    >
      <svg
        viewBox="0 0 200 200"
        width="100%"
        height="100%"
        style={{ display: "block" }}
      >
        <path
          d={d}
          fill="none"
          stroke="#0f172a"
          strokeWidth={Math.max(1, scaleMin(6))}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={STROKE_LENGTH}
          strokeDashoffset={dashoffset}
        />
      </svg>
    </div>
  );
};

function positionFor(
  corner: Corner,
  scaleW: (px: number) => number,
  scaleH: (px: number) => number,
): React.CSSProperties {
  // Inset a touch from the safe-area so the scribble sits in the corner band
  // but doesn't get clipped by the device's rounded corners. Per-axis scale
  // so 16:9 (shorter canvas) keeps the same RELATIVE top/bottom offset.
  const INSET = 56;
  const insetX = scaleW(INSET);
  const insetY = scaleH(INSET);
  switch (corner) {
    case "top-left":
      return { top: insetY, left: insetX };
    case "top-right":
      return { top: insetY, right: insetX };
    case "bottom-left":
      return { bottom: insetY, left: insetX };
    case "bottom-right":
      return { bottom: insetY, right: insetX };
  }
}
