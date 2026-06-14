// PropSlideIn: each prop is a small cutout PNG that slides in from off-frame,
// holds for a few seconds, then slides out. Props are spaced evenly across
// the composition duration so a 2 min video with 5 props gets a prop every
// ~24 s. Side rotates (left, right, top, bottom) per index so consecutive
// props don't all attack from the same edge.

import React from "react";
import {
  Img,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { useCompositionScale } from "../scale";

// Same helper as DoodleShort.tsx. Remotion's staticFile() only accepts
// paths under `public/`; remote URLs from the Cloud Run render path
// must pass through verbatim.
function assetSrc(url: string): string {
  return /^(?:https?:)?\/\//.test(url) ? url : staticFile(url);
}

export interface PropItem {
  // The composition resolves this through staticFile() — the pipeline writes
  // each prop into video/public/<id>/prop-N.png the same way scene images go.
  url: string;
  // Short label that goes under the prop on hover-ish (we don't render it
  // today, but the pipeline emits it for accessibility + future use).
  label?: string;
  // Slide direction. If unset, we cycle through the 4 sides by index.
  side?: "left" | "right" | "top" | "bottom";
}

interface PropSlideInProps {
  enabled: boolean;
  // Renamed from `props` to avoid the React-internal `props` collision.
  // The React-FC props object is also called `props` inside the function
  // and the destructured key was shadowing it, which made `items` get
  // resolved to undefined in some build paths.
  items: PropItem[];
  durationMs: number;
}

const SIDES: Array<NonNullable<PropItem["side"]>> = [
  "right",
  "left",
  "bottom",
  "top",
];

const SLIDE_IN_MS = 350;
const HOLD_MS = 3000;
const SLIDE_OUT_MS = 250;
const TOTAL_MS = SLIDE_IN_MS + HOLD_MS + SLIDE_OUT_MS;
// Base sizes in portrait-canvas px. Phase 1 of
// _plans/2026-06-12-video-aspect-ratio.md scales them at render time.
const PROP_SIZE_BASE = 320;
const SAFE_INSET_BASE = 96;

export const PropSlideIn: React.FC<PropSlideInProps> = ({ enabled, items, durationMs }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { scaleW, scaleH, scaleMin } = useCompositionScale();

  if (!enabled || items.length === 0) return null;

  // Scale once per render — every loop iteration reads the same dims.
  // Prop card is a fixed-aspect square so use `scaleMin` (the smaller of
  // the two ratios). Scaling by width alone on landscape would balloon
  // the card to ~53% of canvas height.
  const propSize = scaleMin(PROP_SIZE_BASE);
  const insetX = scaleW(SAFE_INSET_BASE);
  const insetY = scaleH(SAFE_INSET_BASE);
  const padding = scaleMin(16);
  const radius = scaleMin(12);
  const shadowY = scaleH(12);
  const shadowBlur = scaleW(22);

  const elapsedMs = (frame / fps) * 1000;
  // Even spacing — first prop starts at 1/(n+1) of the duration, last prop
  // finishes before the end. Keeps the prop sequence from butting against
  // the title chip at t=0 or the channel pill at the tail.
  const slot = durationMs / (items.length + 1);

  return (
    <>
      {items.map((p, i) => {
        const startMs = slot * (i + 1) - TOTAL_MS / 2;
        const localMs = elapsedMs - startMs;
        if (localMs < 0 || localMs > TOTAL_MS) return null;

        const side = p.side ?? SIDES[i % SIDES.length];
        const { translate, opacity } = phase(localMs, side);

        return (
          <div
            key={`${p.url}-${i}`}
            style={{
              position: "absolute",
              ...anchorFor(side, i, propSize, insetX, insetY),
              width: propSize,
              height: propSize,
              opacity,
              transform: translate,
              transformOrigin: "center center",
              pointerEvents: "none",
              // White card behind each prop so the doodle ink reads against
              // the cinematic scenes. drop-shadow keeps it "stuck on" feeling
              // without needing a real transparent PNG.
              background: "white",
              borderRadius: radius,
              padding,
              boxShadow: `0 ${shadowY}px ${shadowBlur}px rgba(0,0,0,.35)`,
            }}
          >
            <Img
              src={assetSrc(p.url)}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
              }}
            />
          </div>
        );
      })}
    </>
  );
};

// Slide-in phase math: ease in from off-frame over SLIDE_IN_MS, hold, slide
// out over SLIDE_OUT_MS. Per-side translate composed from a percent offset
// + an "in" position of (0, 0). easeOutCubic on entry, easeInCubic on exit.
function phase(
  localMs: number,
  side: NonNullable<PropItem["side"]>,
): { translate: string; opacity: number } {
  let progress: number;
  let exiting = false;
  if (localMs < SLIDE_IN_MS) {
    progress = localMs / SLIDE_IN_MS;
    progress = 1 - Math.pow(1 - progress, 3); // ease-out cubic
  } else if (localMs < SLIDE_IN_MS + HOLD_MS) {
    progress = 1;
  } else {
    const exit = (localMs - SLIDE_IN_MS - HOLD_MS) / SLIDE_OUT_MS;
    progress = 1 - Math.pow(exit, 3); // ease-in cubic (1 -> 0)
    exiting = true;
  }
  const offset = (1 - progress) * 180; // off-frame distance in percent
  let translate: string;
  switch (side) {
    case "left":
      translate = `translateX(-${offset}%)`;
      break;
    case "right":
      translate = `translateX(${offset}%)`;
      break;
    case "top":
      translate = `translateY(-${offset}%)`;
      break;
    case "bottom":
      translate = `translateY(${offset}%)`;
      break;
  }
  // Fade-in over the first 100 ms; full opacity through hold; fade-out
  // accelerated on exit so the prop is invisible by the time the next
  // chunk's caption animates.
  const opacity = exiting
    ? Math.max(0, Math.min(1, progress * 1.4))
    : Math.min(1, localMs / 100);
  return { translate, opacity };
}

// Where the prop lands when fully on-frame. Cycles which corner of the
// chosen side by index for more variety than just "always center of side".
// Receives the already-scaled sizes so the layout reads off the live canvas
// dims (16:9 vs 9:16) without recomputing per call.
function anchorFor(
  side: NonNullable<PropItem["side"]>,
  i: number,
  propSize: number,
  insetX: number,
  insetY: number,
): React.CSSProperties {
  const variant = Math.floor(i / SIDES.length) % 3; // 0=center, 1=upper, 2=lower
  switch (side) {
    case "left":
      return {
        left: insetX,
        top:
          variant === 0
            ? `calc(50% - ${propSize / 2}px)`
            : variant === 1
              ? insetY * 3
              : `calc(100% - ${propSize + insetY * 3}px)`,
      };
    case "right":
      return {
        right: insetX,
        top:
          variant === 0
            ? `calc(50% - ${propSize / 2}px)`
            : variant === 1
              ? insetY * 3
              : `calc(100% - ${propSize + insetY * 3}px)`,
      };
    case "top":
      return {
        top: insetY * 2,
        left:
          variant === 0
            ? `calc(50% - ${propSize / 2}px)`
            : variant === 1
              ? insetX
              : `calc(100% - ${propSize + insetX}px)`,
      };
    case "bottom":
      return {
        bottom: insetY * 2,
        left:
          variant === 0
            ? `calc(50% - ${propSize / 2}px)`
            : variant === 1
              ? insetX
              : `calc(100% - ${propSize + insetX}px)`,
      };
  }
}
