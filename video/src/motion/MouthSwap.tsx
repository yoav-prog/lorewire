// MouthSwap: small bottom-left talking-head overlay where the protagonist's
// mouth is swapped between SVG shapes timed to the narration. The character
// image has the mouth removed (kie qwen2/image-edit, see pipeline/images.py
// edit_image); we overlay one shape from mouths.ts at a fixed anchor relative
// to that image. Active shape comes from activeShape() in mouth-timing.ts
// (extracted so the rules can be exercised without rendering). No real
// phoneme matching — this reads as "talking", not perfect lip sync.
// See _plans/2026-06-11-mouth-swap.md.

import React from "react";
import { Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { MOUTH_SHAPES } from "./mouths";
import { activeShape } from "./mouth-timing";
import { useCompositionScale } from "../scale";
import type { ShortCaptionWord } from "../types";

// Same helper as DoodleShort.tsx / PropSlideIn.tsx. Remote URLs from
// the Cloud Run render path pass through verbatim; relative paths
// go through staticFile().
function assetSrc(url: string): string {
  return /^(?:https?:)?\/\//.test(url) ? url : staticFile(url);
}

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
// width / height. Calibrated to where kie's gpt-image-2 actually places the
// mouth on the generated busts (~0.66 down), not where the prompt asks for it
// — the model consistently aims slightly lower than the "60-65%" hint, and
// matching reality beats matching intent. Per-image vision detection is a
// follow-up — see the plan's "Risks" / "Deferred" sections.
const ANCHOR = { cx: 0.5, cy: 0.66 };

// Overlay dimensions (base px on the 1080x1920 portrait baseline). The
// card is 3:4 portrait (same aspect as the bust) so objectFit doesn't
// crop the image — that keeps the mouth anchor accurate without a vision
// pass. Inset matches PropSlideIn / LabelPopOn so the talking head
// doesn't fight the channel pill or the caption band. Phase 1 of
// _plans/2026-06-12-video-aspect-ratio.md scales every value at render
// time so 16:9 keeps the same RELATIVE composition.
const CARD_WIDTH_BASE = 240;
const CARD_HEIGHT_BASE = 320;
const SAFE_INSET_BASE = 96;
// Mouth SVG width (base px). Sized so it sits naturally on the rendered
// bust at the base card size; mouths.ts uses a 100x60 viewBox so the
// aspect is preserved.
const MOUTH_WIDTH_BASE = 72;
const MOUTH_HEIGHT_BASE = (MOUTH_WIDTH_BASE * 60) / 100;

export const MouthSwap: React.FC<Props> = ({ enabled, characterUrl, words }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { scaleW, scaleH, scaleMin } = useCompositionScale();

  if (!enabled || !characterUrl) return null;

  const elapsedMs = (frame / fps) * 1000;
  const shape = activeShape(elapsedMs, words);
  const mouth = MOUTH_SHAPES[shape];

  // The talking-head card is a fixed 3:4 portrait box. Scaling both
  // dimensions by width alone makes the card ~422x563 on landscape
  // (1920 wide) — almost the whole canvas height. Use `scaleMin` so
  // the card stays proportional to the smaller canvas axis and fits
  // comfortably on both aspects.
  const cardWidth = scaleMin(CARD_WIDTH_BASE);
  const cardHeight = scaleMin(CARD_HEIGHT_BASE);
  const insetX = scaleW(SAFE_INSET_BASE);
  // Bottom inset stacks SAFE_INSET (above the channel pill) + 96 (a
  // little extra so the head doesn't fight the pill). Both portions
  // scale by the vertical axis.
  const insetY = scaleH(SAFE_INSET_BASE) + scaleH(96);
  // Mouth SVG dims track the card — same fixed-aspect treatment.
  const mouthW = scaleMin(MOUTH_WIDTH_BASE);
  const mouthH = scaleMin(MOUTH_HEIGHT_BASE);
  const radius = scaleMin(18);
  const borderPx = Math.max(1, scaleMin(3));
  const shadowY = scaleH(12);
  const shadowBlur = scaleW(22);

  return (
    <div
      style={{
        position: "absolute",
        left: insetX,
        bottom: insetY,
        width: cardWidth,
        height: cardHeight,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "white",
          borderRadius: radius,
          overflow: "hidden",
          border: `${borderPx}px solid #0f172a`,
          boxShadow: `0 ${shadowY}px ${shadowBlur}px rgba(0,0,0,.35)`,
        }}
      >
        <Img
          src={assetSrc(characterUrl)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
        <svg
          viewBox="0 0 100 60"
          width={mouthW}
          height={mouthH}
          style={{
            position: "absolute",
            left: `calc(${ANCHOR.cx * 100}% - ${mouthW / 2}px)`,
            top: `calc(${ANCHOR.cy * 100}% - ${mouthH / 2}px)`,
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
