// Aspect ratio resolver for the admin UI side. MIRROR of `video/src/aspect.ts`.
//
// Phase 0 of _plans/2026-06-12-video-aspect-ratio.md. Duplicated rather than
// cross-imported because /video/ pulls Remotion runtime modules we don't want
// Next.js bundling into the admin client (same pattern as
// `lorewire-app/src/lib/video-config.ts` vs `video/src/types.ts`).
//
// The two copies MUST stay in sync. `aspect.test.ts` pins the shape with a
// parity assertion so an accidental drift fails CI loudly.

export type VideoAspect = "16:9" | "9:16";

export const VIDEO_ASPECTS: readonly VideoAspect[] = ["16:9", "9:16"] as const;

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
 * Derive the project's aspect enum from a video file's pixel
 * dimensions. MIRROR of `pipeline.aspect.infer_aspect_from_dims`.
 *
 * Used by the segments upload form so the chip auto-flips to match
 * the picked file BEFORE the admin clicks Upload — production
 * diagnosis 2026-06-14: form defaulted to 9:16 and the admin uploaded
 * 16:9 sources without noticing the chip, which silently produced
 * squashed 9:16 normalized copies.
 *
 * Rule is intentionally narrow — the renderer only emits 9:16 and
 * 16:9, so any other shape collapses to one of those:
 *     width >  height  -> 16:9 (landscape)
 *     width <= height  -> 9:16 (portrait, the legacy default)
 * Non-positive or non-finite inputs fall to the legacy default; the
 * server probe (pipeline/segments_worker.py) is the final safety net.
 */
export function inferAspectFromDims(width: number, height: number): VideoAspect {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return LEGACY_DEFAULT_ASPECT;
  }
  if (width <= 0 || height <= 0) return LEGACY_DEFAULT_ASPECT;
  return width > height ? "16:9" : LEGACY_DEFAULT_ASPECT;
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

// ─── Per-aspect intro/outro active pointer keys ──────────────────────────────
// 2026-06-15 (_plans/2026-06-15-intro-outro-per-aspect-active.md): the segment
// library used a single global active pointer per kind
// (`video.active_intro_id` / `video.active_outro_id`), so only one intro and
// one outro could be live and the aspect filter then dropped it on every
// mismatched render. "Active" is now per-aspect: each kind has one active
// pointer per canvas shape. These helpers are the single source of truth for
// the key strings; the admin actions, the resolver, and the seed migration all
// route through them. MIRRORED in pipeline/aspect.py — the two MUST emit
// identical strings (pinned in aspect.test.ts) or the TS reader and Python
// writer would point at different settings rows.
//
// Suffix uses "x" not ":" — the colon is valid in a settings value but reads
// poorly in a key, and "16x9" / "9x16" are unambiguous.
const ASPECT_KEY_SUFFIX: Record<VideoAspect, string> = {
  "16:9": "16x9",
  "9:16": "9x16",
};

/** Settings key for the active intro/outro pointer of a kind + aspect. */
export function activeSegmentSettingKey(
  kind: "intro" | "outro",
  aspect: VideoAspect,
): string {
  return `video.active_${kind}_id_${ASPECT_KEY_SUFFIX[aspect]}`;
}

/** The pre-2026-06-15 single global active pointer. Read once by the seed
 *  migration to populate the per-aspect slots, then vestigial. */
export function legacyActiveSegmentSettingKey(kind: "intro" | "outro"): string {
  return `video.active_${kind}_id`;
}
