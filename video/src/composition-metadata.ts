// Pure derivation of the per-render composition metadata (dimensions +
// duration in frames) from a `ShortVideoConfig`. Lives in its own module
// so unit tests can pin the aspect -> dims contract without spinning up
// Remotion. Root.tsx wraps this in the renderer's `calculateMetadata`
// closure and adds the observability log.
//
// Phase 0 + Phase 1 of _plans/2026-06-12-video-aspect-ratio.md.

import { aspectDims, resolveAspect, type VideoAspect } from "./aspect";
import type { ShortVideoConfig } from "./types";

/** The renderer fps. Single source of truth. */
export const FPS = 30;

export interface DerivedCompositionMetadata {
  durationInFrames: number;
  width: number;
  height: number;
  resolvedAspect: VideoAspect;
}

/**
 * Compute the canvas size + duration Remotion needs for one render.
 *
 *   - durationInFrames honors any clip_start_ms / clip_end_ms trim window
 *     so the rendered MP4 is exactly the clipped span.
 *   - width / height come from the aspect resolver: the per-story field
 *     beats the (caller-supplied, optional) global default, and the legacy
 *     9:16 portrait wins as the floor so back-compat is byte-identical
 *     for configs predating the aspect field.
 *
 * Pure — no Remotion imports, no I/O. Re-used inside Root.tsx's
 * `calculateMetadata` closure.
 */
export function deriveCompositionMetadata(
  cfg: ShortVideoConfig,
  globalDefaultAspect?: VideoAspect,
): DerivedCompositionMetadata {
  const clipStart = cfg.clip_start_ms ?? 0;
  const clipEnd = cfg.clip_end_ms ?? cfg.duration_ms;
  const renderedMs = Math.max(1, clipEnd - clipStart);
  const durationInFrames = Math.max(1, Math.ceil((renderedMs / 1000) * FPS));
  const resolvedAspect = resolveAspect(cfg.aspect, globalDefaultAspect);
  const dims = aspectDims(resolvedAspect);
  return {
    durationInFrames,
    width: dims.width,
    height: dims.height,
    resolvedAspect,
  };
}
