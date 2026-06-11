// MouthSwap: small bottom-left talking-head overlay where the protagonist's
// mouth is swapped between SVG shapes timed to the narration. The character
// image has the mouth removed (kie qwen2/image-edit, see pipeline/images.py
// edit_image); we overlay one shape from mouths.ts at a fixed anchor relative
// to that image. Active shape is decided from the alignment words: during a
// word, cycle through OPEN_CYCLE every 90ms; in a pause (gap >= PAUSE_MS),
// snap to "closed". No real phoneme matching — this reads as "talking", not
// perfect lip sync. See _plans/2026-06-11-mouth-swap.md.

import React from "react";
import { Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { MOUTH_SHAPES, OPEN_CYCLE, type MouthShape } from "./mouths";
import type { ShortCaptionWord } from "../types";

interface Props {
  enabled: boolean;
  // URL to the mouth-removed character image. When empty, the layer renders
  // nothing — we intentionally do NOT fall back to the original character
  // image because then the SVG mouth would float over the painted mouth.
  characterUrl?: string;
  // Alignment words (start_ms / end_ms). Drives the open/closed decision.
  words: ShortCaptionWord[];
}

// Mouth anchor on the character image, expressed as fractions of the image
// width / height. Pipeline's character-generation prompt instructs the model
// to frame the bust with the mouth at (cx=0.50, cy=0.62), so this is what
// the SVG overlay targets. Per-image vision detection is a follow-up — see
// the plan's "Risks" / "Deferred" sections.
const ANCHOR = { cx: 0.5, cy: 0.62 };

// Overlay dimensions (in px on the 1080-wide composition). The character
// image sits in a 320x320 frame in the bottom-left safe zone — same inset
// PropSlideIn / LabelPopOn use, so the talking head doesn't fight the
// channel pill or the caption band.
const CARD_SIZE = 320;
const SAFE_INSET = 96;
// Mouth SVG width (px) on the composition. Sized so it sits naturally on
// the rendered bust at this card size; mouths.ts uses a 100x60 viewBox so
// the aspect is preserved.
const MOUTH_WIDTH = 72;
const MOUTH_HEIGHT = (MOUTH_WIDTH * 60) / 100;

// Pause threshold: a gap between consecutive words shorter than this counts
// as still "talking" (mid-sentence breath); longer than this snaps to closed.
const PAUSE_MS = 200;
// How long each open shape holds before cycling to the next. 90ms ≈ 5-6
// frames at 60fps — fast enough to read as lip-flap, slow enough to be a
// distinct shape per frame instead of a strobe.
const OPEN_HOLD_MS = 90;

export const MouthSwap: React.FC<Props> = ({ enabled, characterUrl, words }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (!enabled || !characterUrl) return null;

  const elapsedMs = (frame / fps) * 1000;
  const shape = activeShape(elapsedMs, words);
  const mouth = MOUTH_SHAPES[shape];

  return (
    <div
      style={{
        position: "absolute",
        left: SAFE_INSET,
        bottom: SAFE_INSET + 96,
        width: CARD_SIZE,
        height: CARD_SIZE,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "white",
          borderRadius: 18,
          overflow: "hidden",
          border: "3px solid #0f172a",
          boxShadow: "0 12px 22px rgba(0,0,0,.35)",
        }}
      >
        <Img
          src={staticFile(characterUrl)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
        <svg
          viewBox="0 0 100 60"
          width={MOUTH_WIDTH}
          height={MOUTH_HEIGHT}
          style={{
            position: "absolute",
            left: `calc(${ANCHOR.cx * 100}% - ${MOUTH_WIDTH / 2}px)`,
            top: `calc(${ANCHOR.cy * 100}% - ${MOUTH_HEIGHT / 2}px)`,
            pointerEvents: "none",
          }}
        >
          {mouth.paths.map((p, i) => (
            <path
              key={i}
              d={p.d}
              fill={p.fill}
              stroke={p.stroke}
              strokeWidth={p.strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </svg>
      </div>
    </div>
  );
};

// Decide which mouth shape is active at elapsedMs given the alignment words.
// Rules:
//   1. If elapsedMs falls inside a word's [start_ms, end_ms): open. Cycle
//      through OPEN_CYCLE based on the word's start time so the same word
//      reliably picks the same first shape (deterministic per-render).
//   2. If elapsedMs is in a pause shorter than PAUSE_MS: open too — short
//      gaps inside a sentence read as continuous talking.
//   3. Otherwise: closed.
// Words are assumed start-sorted (pipeline writes them in narration order).
function activeShape(elapsedMs: number, words: ShortCaptionWord[]): MouthShape {
  if (words.length === 0) return "closed";

  // Binary search would be cleaner for long stories, but the per-chunk word
  // counts are small and Remotion calls this per frame; the linear walk is
  // fine and easier to reason about.
  let currentWord: ShortCaptionWord | null = null;
  let prevWord: ShortCaptionWord | null = null;
  let nextWord: ShortCaptionWord | null = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (elapsedMs >= w.start_ms && elapsedMs < w.end_ms) {
      currentWord = w;
      break;
    }
    if (w.end_ms <= elapsedMs) prevWord = w;
    if (w.start_ms > elapsedMs && nextWord === null) nextWord = w;
  }

  if (currentWord) {
    return pickOpen(elapsedMs - currentWord.start_ms, currentWord.start_ms);
  }
  // In a gap. Open if the gap is short enough.
  if (prevWord && nextWord) {
    const gap = nextWord.start_ms - prevWord.end_ms;
    if (gap < PAUSE_MS) {
      return pickOpen(elapsedMs - prevWord.end_ms, prevWord.end_ms);
    }
  }
  return "closed";
}

function pickOpen(localMs: number, anchorMs: number): MouthShape {
  // Anchor the cycle to the word boundary so the shape feels phase-locked
  // to speech onset rather than drifting with the composition clock.
  const idx = Math.floor(localMs / OPEN_HOLD_MS) + Math.floor(anchorMs / 1000);
  return OPEN_CYCLE[Math.abs(idx) % OPEN_CYCLE.length];
}
