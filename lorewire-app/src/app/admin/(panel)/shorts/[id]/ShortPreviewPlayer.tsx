"use client";

// Live preview for the short editor. Mirrors the long-form video editor's
// preview wiring: @remotion/player drives PreviewComposition (the simpler
// editor-side composition in components/video-preview/PreviewComposition.tsx)
// from the current ShortConfig. Edits in any tab show up in the player
// without a re-render — the input props derive from the live config via a
// memoized shortConfigToVideoConfig() call.
//
// The player is sticky in the right column so it's always visible.
//
// Notes / limitations:
//  - Audio: uses short_config.voiceover_url. NULL on cold start (no
//    render run yet) — the preview plays silent video. After Lane B /
//    full render lands, the URL appears on short_config and the next
//    paint picks it up.
//  - Scenes: doodle_frames are public GCS URLs already; the composition
//    reads them via plain <img>.
//  - This composition deliberately does NOT include intro/outro splices,
//    music tracks, or motion beats — none apply to article shorts. The
//    final render is byte-for-byte produced by video/src/DoodleShort.tsx
//    on Cloud Run; this preview is the editor's iteration surface.
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md (preview slice).

import dynamic from "next/dynamic";
import { useMemo } from "react";
import type { ShortConfig } from "@/lib/short-config";
import { resolveShortCaptionStyle } from "@/lib/short-caption-style-to-props";
import { shortConfigToVideoConfig } from "@/lib/short-config-to-video-config";

const FPS = 30;
const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1920;

// Dynamic import keeps Remotion out of the initial bundle.
const PlayerNoSSR = dynamic(
  () => import("@remotion/player").then((m) => m.Player),
  {
    ssr: false,
    loading: () => (
      <div
        className="rounded-lg border border-line bg-bg"
        style={{ aspectRatio: "9 / 16" }}
      >
        <div className="flex h-full items-center justify-center font-mono text-[11px] uppercase tracking-wider text-muted">
          Loading preview…
        </div>
      </div>
    ),
  },
);

// Same dynamic shape for the composition. PreviewComposition imports
// Remotion runtime, so it must be code-split off the SSR path too.
const PreviewCompositionNoSSR = dynamic(
  () =>
    import("@/components/video-preview/PreviewComposition").then(
      (m) => m.PreviewComposition,
    ),
  { ssr: false },
);

export function ShortPreviewPlayer({
  config,
  baselineCaptionTemplate,
}: {
  config: ShortConfig;
  /** caption_template extracted from the latest done short_render's props.
   *  Used as the floor for the preview's style so a settings-level override
   *  (e.g. `caption.color = #ff0000` baked into every render's template)
   *  shows up in the preview too — not just in the rendered MP4. Pre-fix
   *  the preview used TS-hardcoded defaults (yellow) which lied about what
   *  the next render would actually look like. */
  baselineCaptionTemplate?: Record<string, unknown> | null;
}) {
  // Memoize the converted ShortVideoConfig so the Player doesn't see a fresh
  // object reference on every keystroke — only on actual config changes.
  const videoConfig = useMemo(
    () => shortConfigToVideoConfig(config),
    [config],
  );

  // Frame urls: the preview composition takes a parallel array of absolute
  // browser URLs. Shorts' doodle_frames already carry public GCS URLs, so
  // we pass them through.
  const frameUrls = useMemo(
    () => config.doodle_frames.map((f) => f.url),
    [config.doodle_frames],
  );

  const durationFrames = Math.max(
    1,
    Math.ceil((videoConfig.duration_ms / 1000) * FPS),
  );

  // PreviewComposition requires bodyDurationFrames + audioUrl as SEPARATE
  // props (not derived from config.duration_ms / config.voiceover_url).
  // Shorts carry no intro/outro and never trim, so bodyDurationFrames is
  // just the full duration and there's no offset. Without
  // bodyDurationFrames the body Series.Sequence renders with 0 frames →
  // blank canvas. Without audioUrl the <Audio> inside the body never
  // mounts → silent playback. Caught in prod after the initial preview
  // ship.
  const audioUrl = config.voiceover_url ?? null;
  // Caption style: layer DEFAULTS → baseline render's caption_template →
  // editor's caption_style overrides. Passing the result unconditionally
  // (always non-null now) means the preview shows the SAME style stack the
  // renderer will use, including settings-level overrides that pre-fix
  // never reached the preview.
  const captionStyle = useMemo(
    () => resolveShortCaptionStyle(config, baselineCaptionTemplate),
    [config, baselineCaptionTemplate],
  );
  const playerInputProps = useMemo(
    () => ({
      config: videoConfig,
      frameUrls,
      audioUrl,
      bodyDurationFrames: durationFrames,
      intro: null,
      outro: null,
      captionStyle,
    }),
    [videoConfig, frameUrls, audioUrl, durationFrames, captionStyle],
  );

  return (
    <div className="sticky top-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Live preview
        </span>
        <span className="font-mono text-[10px] text-muted">
          {(videoConfig.duration_ms / 1000).toFixed(1)}s · {config.doodle_frames.length} frames
        </span>
      </div>
      <div
        className="overflow-hidden rounded-lg border border-line"
        style={{ aspectRatio: "9 / 16", background: "#fbfaf4" }}
      >
        <PlayerNoSSR
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          component={PreviewCompositionNoSSR as any}
          inputProps={playerInputProps}
          durationInFrames={durationFrames}
          compositionWidth={CANVAS_WIDTH}
          compositionHeight={CANVAS_HEIGHT}
          fps={FPS}
          controls
          acknowledgeRemotionLicense
          style={{ width: "100%", height: "100%" }}
        />
      </div>
      {!videoConfig.voiceover_url && (
        <p className="rounded-md border border-line bg-surface px-2 py-1 font-mono text-[10px] text-muted">
          No voiceover yet — plays silent until the first render finishes.
        </p>
      )}
    </div>
  );
}
