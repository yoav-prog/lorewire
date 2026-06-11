// LabelPopOn: for each caption chunk, when the beat is enabled, pops a small
// bold label with the chunk's first word at the chunk's start_ms. Position
// cycles through 4 corners by chunk index so consecutive chunks don't stack.
// Animates with a scale-from-0.5 entry over 140ms; holds through the chunk
// duration; fades out over the last 100ms. The label sits in the safe zone
// (96px from each edge) so it doesn't clip the title chip or the bottom
// channel pill.

import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { ShortCaptionChunk } from "../types";
import { FONT_FAMILY } from "../fonts";

interface Props {
  enabled: boolean;
  caption: ShortCaptionChunk;
  index: number;
}

const POP_IN_MS = 140;
const POP_OUT_MS = 100;
const SAFE_INSET = 96;

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const CORNERS: Corner[] = ["top-right", "bottom-left", "top-left", "bottom-right"];

export const LabelPopOn: React.FC<Props> = ({ enabled, caption, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (!enabled) return null;

  // First non-empty token in the chunk's text. We prefer words[] if present
  // since alignment was the source of truth for the chunk, but fall back to
  // splitting text() so a chunk without alignment still renders something.
  const firstWord =
    caption.words?.[0]?.word ||
    caption.text.split(/\s+/).find((t) => t.trim().length > 0) ||
    "";
  if (!firstWord) return null;

  const elapsedMs = (frame / fps) * 1000;
  const sinceStart = elapsedMs - caption.start_ms;
  const untilEnd = caption.end_ms - elapsedMs;
  if (sinceStart < 0 || untilEnd < 0) return null;

  const entry = Math.min(1, Math.max(0, sinceStart / POP_IN_MS));
  const exit = Math.min(1, Math.max(0, untilEnd / POP_OUT_MS));
  // Scale from 0.5 -> 1.0 during entry, slight overshoot at 1.06 mid-entry.
  const scale = 0.5 + 0.5 * entry + 0.06 * Math.sin(entry * Math.PI);
  const opacity = Math.min(entry, exit);

  const corner = CORNERS[index % CORNERS.length];
  const positionStyle = positionFor(corner);

  return (
    <div
      style={{
        position: "absolute",
        ...positionStyle,
        opacity,
        transform: `scale(${scale})`,
        transformOrigin:
          corner.startsWith("top")
            ? corner.endsWith("left")
              ? "top left"
              : "top right"
            : corner.endsWith("left")
              ? "bottom left"
              : "bottom right",
      }}
    >
      <div
        style={{
          padding: "10px 18px",
          borderRadius: 10,
          background: "#FFD84D",
          color: "#0f172a",
          border: "3px solid #0f172a",
          fontFamily: FONT_FAMILY,
          fontWeight: 900,
          fontSize: 36,
          letterSpacing: -0.5,
          textTransform: "uppercase",
          boxShadow: "0 8px 18px rgba(0,0,0,.35)",
          transform: `rotate(${corner.startsWith("top") ? -3 : 3}deg)`,
        }}
      >
        {firstWord.replace(/[.,!?;:]+$/, "")}
      </div>
    </div>
  );
};

function positionFor(corner: Corner): React.CSSProperties {
  switch (corner) {
    case "top-left":
      return { top: SAFE_INSET, left: SAFE_INSET };
    case "top-right":
      return { top: SAFE_INSET, right: SAFE_INSET };
    case "bottom-left":
      return { bottom: SAFE_INSET + 64, left: SAFE_INSET };
    case "bottom-right":
      return { bottom: SAFE_INSET + 64, right: SAFE_INSET };
  }
}
