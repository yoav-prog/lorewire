// Aspect ratio resolver for the LoreWire video pipeline.
//
// Phase 0 of _plans/2026-06-12-video-aspect-ratio.md. The pipeline historically
// hardcoded 1080x1920 (9:16, portrait) everywhere. To support 16:9 (landscape)
// alongside the portrait flow without breaking existing renders, every site
// that wants pixel dimensions reads them through `aspectDims(aspect)` and the
// renderer + admin pick which orientation to feed by reading a story-level
// `aspect` field with a global-default fallback and a hardcoded "9:16"
// safety net for legacy rows.
//
// This module is pure data — no Remotion imports, no React, no I/O. Mirrored
// in `lorewire-app/src/lib/aspect.ts` so the admin can read the same shapes
// without pulling the renderer's runtime bundle into Next.js. The two copies
// MUST stay in sync; the lorewire-app mirror has a parity test that pins the
// shape.

export type VideoAspect = "16:9" | "9:16";

// The supported aspects in a single place — handy for runtime validation
// (parseVideoConfig) and for any settings UI that needs to enumerate.
export const VIDEO_ASPECTS: readonly VideoAspect[] = ["16:9", "9:16"] as const;

// Hardcoded fallback when neither the per-story aspect nor the global
// default setting is set. This is the orientation the pipeline shipped
// with — keeping it as the implicit default guarantees that any
// pre-existing row missing an `aspect` field renders byte-identical.
export const LEGACY_DEFAULT_ASPECT: VideoAspect = "9:16";

export interface AspectDims {
  /** Rendered MP4 width in pixels. */
  width: number;
  /** Rendered MP4 height in pixels. */
  height: number;
  /** CSS `aspect-ratio` value (e.g. "16 / 9") for editor preview boxes. */
  cssRatio: string;
  /** FFmpeg `scale` / `crop` size string (e.g. "1920:1080") for the
   *  segment-normaliser. */
  ffmpegSize: string;
}

const DIMS: Record<VideoAspect, AspectDims> = {
  "16:9": {
    width: 1920,
    height: 1080,
    cssRatio: "16 / 9",
    ffmpegSize: "1920:1080",
  },
  "9:16": {
    width: 1080,
    height: 1920,
    cssRatio: "9 / 16",
    ffmpegSize: "1080:1920",
  },
};

/** Return the pixel + CSS + ffmpeg dimensions for a given aspect. Pure. */
export function aspectDims(aspect: VideoAspect): AspectDims {
  return DIMS[aspect];
}

/** Type guard for runtime values coming from JSON / form data. */
export function isVideoAspect(value: unknown): value is VideoAspect {
  return value === "16:9" || value === "9:16";
}

/**
 * Walk the resolution chain to pick the aspect for one render:
 *   1. per-story `aspect` field on `ShortVideoConfig`,
 *   2. global default from settings (`video.default_aspect`),
 *   3. `LEGACY_DEFAULT_ASPECT` ("9:16") so configs from before this
 *      change still render byte-identical.
 *
 * The caller is responsible for fetching the global default — this
 * function stays pure so it's safe to import anywhere.
 */
export function resolveAspect(
  configAspect: VideoAspect | undefined,
  globalDefault: VideoAspect | undefined,
): VideoAspect {
  if (configAspect && isVideoAspect(configAspect)) return configAspect;
  if (globalDefault && isVideoAspect(globalDefault)) return globalDefault;
  return LEGACY_DEFAULT_ASPECT;
}
