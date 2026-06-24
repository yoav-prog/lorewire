"use client";

// Segmented progress bar across the top of the Stories viewer. One
// segment per wire in the playlist:
//
//   - segments before the active index are filled
//   - the active segment animates 0→100% over `durationMs`, paused via
//     `animation-play-state` (CSS, not JS, so a paused viewer stops
//     burning frames)
//   - segments after the active index are empty
//
// `key={index-of-active + restartToken}` on the active segment forces
// the CSS animation to restart when the user taps prev/next or the
// auto-advance fires. Without it React would keep the same element and
// the browser would freeze the half-finished animation at the new
// duration.

import { memo } from "react";

export interface StoriesProgressBarProps {
  /** Total wires in the playlist. */
  total: number;
  /** Active index (0..total-1). */
  activeIndex: number;
  /** Active wire's duration in ms. For videos, the viewer should pass
   *  the metadata-loaded duration; for image-only wires the configured
   *  dwell. */
  durationMs: number;
  /** True when the viewer is paused (hold-to-pause, tab hidden,
   *  reduced motion off — the viewer decides). */
  paused: boolean;
  /** Bumps when the active wire changes OR when the user manually
   *  restarts. Used as part of the key on the active segment so the
   *  CSS animation restarts cleanly. */
  restartToken: number;
  /** When true, no auto-advance animation runs — the segment fills the
   *  moment the wire becomes active and stays full. Drives the
   *  `prefers-reduced-motion` fallback. */
  reducedMotion?: boolean;
}

function ProgressBarInner({
  total,
  activeIndex,
  durationMs,
  paused,
  restartToken,
  reducedMotion,
}: StoriesProgressBarProps) {
  if (total <= 0) return null;
  return (
    <div
      className="absolute top-0 inset-x-0 z-30 flex gap-[3px] px-2 pt-2 pointer-events-none"
      aria-hidden
    >
      {Array.from({ length: total }, (_, i) => {
        const state =
          i < activeIndex ? "done" : i === activeIndex ? "active" : "future";
        return (
          <div
            key={i}
            className="flex-1 h-[2.5px] rounded-full overflow-hidden"
            style={{ background: "rgba(255,255,255,.28)" }}
          >
            {state === "done" && (
              <div className="h-full w-full" style={{ background: "rgba(255,255,255,.95)" }} />
            )}
            {state === "active" && (
              <div
                key={`fill-${restartToken}`}
                className="h-full"
                style={{
                  background: "rgba(255,255,255,.95)",
                  width: reducedMotion ? "100%" : "0%",
                  animation: reducedMotion
                    ? undefined
                    : `stories-fill ${durationMs}ms linear forwards`,
                  animationPlayState: paused ? "paused" : "running",
                }}
              />
            )}
          </div>
        );
      })}
      <style>{`@keyframes stories-fill { from { width: 0%; } to { width: 100%; } }`}</style>
    </div>
  );
}

export const StoriesProgressBar = memo(ProgressBarInner);
