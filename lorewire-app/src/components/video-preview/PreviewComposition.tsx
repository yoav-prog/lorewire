// Editor-side preview composition.
//
// Deliberately NOT the same code as video/src/DoodleShort.tsx — that one is
// the renderer's view (full motion beats, mouth-swap, prop slide, scribble
// draw, label pop) and pulling its imports into lorewire-app would bundle
// Remotion's staticFile + a chain of motion components the editor doesn't
// need. The preview's job is "show the trim window and caption flow
// roughly right" so an admin can iterate on edits before kicking off a
// real render — not "match the rendered MP4 frame-for-frame".
//
// What this preview DOES:
//   - 9:16 aspect on a #fbfaf4 canvas (the doodle look)
//   - Image-per-frame held for the right window (cross-faded)
//   - Caption text band with the active chunk
//   - Title chip top-center during the hook (first ~1.2 s)
//   - clip_start_ms / clip_end_ms honored end-to-end
//   - Voiceover audio with startFrom = clipStartFrames so playback lines up
//   - Intro / outro segment MP4s spliced inline via Remotion <Series> +
//     <OffthreadVideo>, so the editor's preview matches what the ffmpeg
//     concat will produce on render (added 2026-06-13).
//
// What it deliberately DOESN'T:
//   - Motion beats (MicroWiggle, ScribbleDraw, PropSlideIn, MouthSwap, LabelPopOn)
//   - Ken-Burns pan/zoom
//
// Per-word highlight (added 2026-06-14): the four non-`none` modes —
// karaoke / color / scale / background — render the same per-word effect
// the rendered MP4 will, using `splitChunkWords` + `findActiveWordIndex`
// from `@/lib/caption-words`. That helper file is kept parity-locked
// with the renderer's copy at `video/src/caption-words.ts` so the
// editor's preview matches the final frame byte-for-byte at the
// word-rendering level.
//
// Editors that need exact frame fidelity should hit "Render" — the queued
// MP4 is the canonical output.

import {
  AbsoluteFill,
  Audio,
  interpolate,
  OffthreadVideo,
  Sequence,
  Series,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { Overlay, ShortVideoConfig } from "@/lib/video-config";
import {
  findActiveWordIndex,
  splitChunkWords,
} from "@/lib/caption-words";
import { PreviewEmptyState } from "./PreviewEmptyState";

const TITLE_VISIBLE_MS = 1200;
const TITLE_FADE_MS = 600;
const CHUNK_FADE_MS = 80;

// Props the editor passes. We keep ShortVideoConfig as a typed slot and
// add a parallel `frameUrls` array — the server resolves each
// doodle_frame.url to an absolute browser URL so the preview can <img> them
// directly without going through Remotion's staticFile resolver.
//
// captionStyle (optional) carries the resolved per-story caption style so
// the Remotion overlay reflects edits in the Caption style tab. Backward
// compat: when omitted, the layer uses the hardcoded defaults that
// shipped before the per-video style work landed.
export interface CaptionStyleProps {
  position_y: number;
  size_scale: number;
  padding_x: number;
  text_transform: "uppercase" | "none" | "lowercase";
  font_weight: number;
  letter_spacing: number;
  line_height: number;
  color: string;
  active_word_color: string;
  spoken_word_color: string;
  outline_color: string;
  outline_width: number;
  entry_effect: "none" | "fade" | "pop" | "slide-up";
  word_highlight: "none" | "karaoke" | "color" | "scale" | "background";
}

/** Resolved intro/outro segment for inline playback. URL is the segment's
 *  `normalized_url` (GCS https or `/generated/...` path; both are
 *  browser-playable). `durationFrames` is pre-computed from
 *  `duration_ms` by the editor at fps=FPS so the composition doesn't have
 *  to know about ms-to-frame math twice. */
export interface PreviewSegmentSpec {
  url: string;
  durationFrames: number;
}

export interface PreviewProps extends Record<string, unknown> {
  config: ShortVideoConfig;
  frameUrls: string[];
  audioUrl: string | null;
  captionStyle?: CaptionStyleProps;
  /** Resolved intro segment (or null when none applies — story has the
   *  skip flag set, no global default, aspect mismatch, etc.). */
  intro?: PreviewSegmentSpec | null;
  /** Resolved outro segment. Same null-when-not-applicable contract. */
  outro?: PreviewSegmentSpec | null;
  /** Pre-computed body durationInFrames (the trim window). Pushed into
   *  the body's Sequence so the Player's outer durationInFrames can grow
   *  by intro + outro without the body recomputing anything. */
  bodyDurationFrames: number;
  /** How a resolved intro/outro fits into the preview canvas (2026-06-14
   *  toggle). "cover" fills the frame and crops on aspect mismatch — the
   *  original behavior; the segment looks full-bleed but a mismatched
   *  file shape silently zoom-crops. "contain" letterboxes instead, so
   *  a mismatch is visible. Defaults to "cover" so callers that don't
   *  pass anything stay byte-identical to the pre-toggle behavior. */
  previewSegmentFit?: "cover" | "contain";
}

interface FrameWindow {
  url: string;
  fromFrames: number;
  lengthFrames: number;
}

// Outer guard: routes empty / unresolved inputs to a labeled diagnostic
// rather than letting the player iframe paint an unlabeled cream (or worse,
// the Player container's backdrop showing through). React's rules of hooks
// mean the hook-using body has to live in a sibling component — see
// `PreviewCompositionInner` below.
//
// Series wrapper: when an intro or outro segment resolves, splice them
// inline so the editor preview shows what the ffmpeg concat will produce.
// Each Sequence resets useCurrentFrame() to 0 inside its own range, so the
// body composition's caption / image-window math doesn't need to know about
// the intro offset.
export function PreviewComposition(props: PreviewProps) {
  const {
    config,
    frameUrls,
    intro,
    outro,
    bodyDurationFrames,
    previewSegmentFit,
  } = props;
  const segmentFit = previewSegmentFit ?? "cover";
  if (config.doodle_frames.length === 0) {
    return (
      <AbsoluteFill style={{ background: "#fbfaf4" }}>
        <PreviewEmptyState reason="no-frames" />
      </AbsoluteFill>
    );
  }
  const noResolvedUrls =
    frameUrls.length === 0 || frameUrls.every((u) => !u);
  if (noResolvedUrls) {
    return (
      <AbsoluteFill style={{ background: "#fbfaf4" }}>
        <PreviewEmptyState
          reason="no-frame-urls"
          detail={`${config.doodle_frames.length} frame(s) in config · 0 resolved URLs`}
        />
      </AbsoluteFill>
    );
  }
  // Body Sequence has to use the pre-computed body duration so the audio
  // inside it gets the right window length. The Player's outer
  // durationInFrames (set by EditorClient) covers intro + body + outro.
  const safeBodyDuration = Math.max(1, bodyDurationFrames);
  return (
    <AbsoluteFill style={{ background: "#fbfaf4" }}>
      <Series>
        {intro && intro.url && intro.durationFrames > 0 && (
          <Series.Sequence
            durationInFrames={intro.durationFrames}
            layout="none"
          >
            <SegmentClip url={intro.url} kind="intro" fit={segmentFit} />
          </Series.Sequence>
        )}
        <Series.Sequence durationInFrames={safeBodyDuration} layout="none">
          <PreviewCompositionInner
            {...props}
            bodyDurationFrames={safeBodyDuration}
          />
        </Series.Sequence>
        {outro && outro.url && outro.durationFrames > 0 && (
          <Series.Sequence
            durationInFrames={outro.durationFrames}
            layout="none"
          >
            <SegmentClip url={outro.url} kind="outro" fit={segmentFit} />
          </Series.Sequence>
        )}
      </Series>
    </AbsoluteFill>
  );
}

// Intro / outro inline clip. OffthreadVideo is Remotion's recommended
// component for sequenced video clips (per /remotion-dev/remotion docs,
// 2026-06-13). The MP4 plays at native size into the canvas; we wrap it
// in AbsoluteFill so it covers the editor's preview box at any aspect.
// Audio is left unmuted — these segments carry their own music beds and
// the body's <Audio> only plays during the body Sequence, so there's no
// double-audio collision.
//
// `fit` chooses how a segment renders when its actual pixel shape doesn't
// match the editor canvas. "cover" fills the frame and crops (the original
// behavior — looks full-bleed but silently hides shape mismatches).
// "contain" letterboxes — the bars expose any mismatch instantly so a bad
// normalized file shows up as a black-bar issue rather than as a mystery
// zoom-crop on top of valid story content. Default "cover" preserves the
// pre-toggle look for everyone who hasn't flipped the setting.
function SegmentClip({
  url,
  kind,
  fit = "cover",
}: {
  url: string;
  kind: "intro" | "outro";
  fit?: "cover" | "contain";
}) {
  return (
    <AbsoluteFill style={fit === "contain" ? { background: "#000" } : undefined}>
      <OffthreadVideo
        src={url}
        style={{
          width: "100%",
          height: "100%",
          objectFit: fit,
        }}
        // Per rule 14, identify the clip in any Remotion log surface.
        // The data-* attribute survives into the rendered DOM for browser
        // inspectors without affecting Remotion's render. `data-segment-fit`
        // surfaces the active toggle value alongside the kind so a "why
        // does this segment look wrong" debug session has the answer in
        // DevTools without reading the setting back from the DB.
        data-segment-kind={kind}
        data-segment-fit={fit}
      />
    </AbsoluteFill>
  );
}

function PreviewCompositionInner({
  config,
  frameUrls,
  audioUrl,
  captionStyle,
}: PreviewProps) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const clipStartMs = config.clip_start_ms ?? 0;
  const clipEndMs = config.clip_end_ms ?? config.duration_ms;
  const clipStartFrames = Math.round((clipStartMs / 1000) * fps);
  const elapsedMs = (frame / fps) * 1000 + clipStartMs;

  // Build the window list the same way DoodleShort does, but with the
  // browser-friendly URLs the server resolved. Drop windows entirely
  // outside the trim and shift survivors by -clipStartFrames.
  const frameWindows: FrameWindow[] = config.doodle_frames
    .map((f, i) => {
      const captionForFrame = config.captions[f.caption_chunk_start_index];
      const startMs = captionForFrame?.start_ms ?? 0;
      const next = config.doodle_frames[i + 1];
      const nextStartMs = next
        ? config.captions[next.caption_chunk_start_index]?.start_ms ??
          clipEndMs
        : clipEndMs;
      return {
        url: frameUrls[i] ?? "",
        startMs,
        nextStartMs,
      };
    })
    .filter((w) => w.nextStartMs > clipStartMs && w.startMs < clipEndMs)
    .map((w) => {
      const absoluteFromFrames = Math.max(
        0,
        Math.round((w.startMs / 1000) * fps),
      );
      const lengthFrames = Math.max(
        1,
        Math.round(((w.nextStartMs - w.startMs) / 1000) * fps),
      );
      const fromFrames = Math.max(0, absoluteFromFrames - clipStartFrames);
      const cappedLength = Math.max(
        1,
        Math.min(lengthFrames, durationInFrames - fromFrames),
      );
      return { url: w.url, fromFrames, lengthFrames: cappedLength };
    });

  const activeFrame =
    frameWindows.find(
      (w) => frame >= w.fromFrames && frame < w.fromFrames + w.lengthFrames,
    ) ?? frameWindows[frameWindows.length - 1];

  const activeCaption = config.captions.find(
    (c) => elapsedMs >= c.start_ms && elapsedMs < c.end_ms,
  );

  const titleOpacity =
    elapsedMs < TITLE_VISIBLE_MS
      ? 1
      : Math.max(0, 1 - (elapsedMs - TITLE_VISIBLE_MS) / TITLE_FADE_MS);

  return (
    <AbsoluteFill style={{ background: "#fbfaf4" }}>
      {audioUrl && (
        // startFrom matches the renderer's contract so trim previews line
        // up with the eventual MP4. Volume is left at 1.0 — the preview
        // doesn't need the music-track mix yet.
        <Audio src={audioUrl} startFrom={clipStartFrames} />
      )}

      {activeFrame?.url && (
        <img
          src={activeFrame.url}
          alt=""
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      )}

      {config.title && titleOpacity > 0 && (
        <div
          style={{
            position: "absolute",
            top: 96,
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            opacity: titleOpacity,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              fontSize: 40,
              fontWeight: 800,
              padding: "12px 28px",
              borderRadius: 24,
              background: "rgba(255,255,255,0.92)",
              color: "#0f172a",
              border: "3px solid #0f172a",
              letterSpacing: -0.5,
              maxWidth: 900,
              textAlign: "center",
              lineHeight: 1.1,
            }}
          >
            {config.title}
          </div>
        </div>
      )}

      {activeCaption && (
        <CaptionBand
          caption={activeCaption}
          elapsedMs={elapsedMs}
          style={captionStyle}
        />
      )}

      {/* Overlays — mirror of DoodleShort's overlay layer so the editor's
          live preview matches what'll render. Each overlay is a Sequence
          windowed to its [start_ms, end_ms] in the trimmed timeline. */}
      {config.overlays?.map((o, i) => {
        if (o.end_ms <= clipStartMs || o.start_ms >= clipEndMs) return null;
        const absFrom = Math.max(0, Math.round((o.start_ms / 1000) * fps));
        const fromFrames = Math.max(0, absFrom - clipStartFrames);
        const lengthFrames = Math.max(
          1,
          Math.round(((o.end_ms - o.start_ms) / 1000) * fps),
        );
        const cappedLength = Math.max(
          1,
          Math.min(lengthFrames, durationInFrames - fromFrames),
        );
        return (
          <Sequence
            key={`overlay-${i}-${o.start_ms}`}
            from={fromFrames}
            durationInFrames={cappedLength}
          >
            <OverlayLayer overlay={o} />
          </Sequence>
        );
      })}

      {config.channel_name && (
        <div
          style={{
            position: "absolute",
            bottom: 96,
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              fontSize: 28,
              fontWeight: 700,
              padding: "8px 22px",
              borderRadius: 999,
              background: "rgba(255,255,255,0.92)",
              color: "#0f172a",
              border: "2px solid #0f172a",
              letterSpacing: 0.4,
            }}
          >
            @ {config.channel_name}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
}

function OverlayLayer({ overlay }: { overlay: Overlay }) {
  return (
    <div
      style={{
        position: "absolute",
        left: `${Math.max(0, Math.min(1, overlay.x)) * 100}%`,
        top: `${Math.max(0, Math.min(1, overlay.y)) * 100}%`,
        transform: "translate(-50%, -50%)",
        maxWidth: "80%",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          fontSize: 56,
          fontWeight: 800,
          color: "#fbfaf4",
          textAlign: "center",
          lineHeight: 1.1,
          textShadow:
            "0 0 12px rgba(15, 23, 42, 0.85), 0 4px 0 #0f172a, 0 -4px 0 #0f172a, 4px 0 0 #0f172a, -4px 0 0 #0f172a",
          padding: "8px 16px",
        }}
      >
        {overlay.text}
      </div>
    </div>
  );
}

function CaptionBand({
  caption,
  elapsedMs,
  style,
}: {
  caption: {
    start_ms: number;
    end_ms: number;
    text: string;
    words?: { word: string; start_ms: number; end_ms: number }[];
  };
  elapsedMs: number;
  style?: CaptionStyleProps;
}) {
  const sinceStart = elapsedMs - caption.start_ms;
  const untilEnd = caption.end_ms - elapsedMs;
  const fadeIn = interpolate(sinceStart, [0, CHUNK_FADE_MS], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(untilEnd, [0, CHUNK_FADE_MS], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const opacity = Math.min(fadeIn, fadeOut);

  // Resolve each style field — fall through to the historical hardcoded
  // values when caption style is absent (e.g. legacy callers that haven't
  // been updated). Base font size 88px is the pre-template behavior;
  // size_scale multiplies it.
  const positionY = style?.position_y ?? 0.68;
  const sizeScale = style?.size_scale ?? 1;
  const paddingX = style?.padding_x ?? 64;
  const fontWeight = style?.font_weight ?? 900;
  const letterSpacing = style?.letter_spacing ?? -0.5;
  const lineHeight = style?.line_height ?? 1.05;
  const textTransform = style?.text_transform ?? "uppercase";
  const color = style?.color ?? "#facc15";
  const activeWordColor = style?.active_word_color ?? "#ffffff";
  const spokenWordColor =
    style?.spoken_word_color ?? "rgba(250, 204, 21, 0.45)";
  const outlineColor = style?.outline_color ?? "#0f172a";
  const outlineWidth = style?.outline_width ?? 6;
  const wordHighlight = style?.word_highlight ?? "karaoke";
  const fontSize = 88 * sizeScale;

  const containerStyle: React.CSSProperties = {
    position: "absolute",
    top: `${positionY * 100}%`,
    left: 0,
    right: 0,
    display: "flex",
    justifyContent: "center",
    padding: `0 ${paddingX}px`,
    opacity,
    pointerEvents: "none",
  };
  const textBlockStyle: React.CSSProperties = {
    fontSize,
    fontWeight,
    fontFamily: "Arial Black, Arial, sans-serif",
    textTransform,
    letterSpacing,
    lineHeight,
    textAlign: "center",
    color,
    WebkitTextStroke: `${outlineWidth}px ${outlineColor}`,
    textShadow: [
      `0 0 1px ${outlineColor}`,
      `0 ${outlineWidth - 2}px 0 ${outlineColor}`,
      `0 -${outlineWidth - 2}px 0 ${outlineColor}`,
      `${outlineWidth - 2}px 0 0 ${outlineColor}`,
      `-${outlineWidth - 2}px 0 0 ${outlineColor}`,
    ].join(", "),
    maxWidth: "100%",
  };

  // wordHighlight === "none" or no words → single block, no per-word styling.
  // The split helper returns [] for an empty chunk; treat that the same as
  // "none" so we don't render an empty span tree.
  const words = splitChunkWords(caption);
  if (wordHighlight === "none" || words.length === 0) {
    return (
      <div style={containerStyle}>
        <div style={textBlockStyle}>{caption.text}</div>
      </div>
    );
  }

  const activeIdx = findActiveWordIndex(words, elapsedMs);

  // Background-pill geometry scales with font size so the pill stays
  // proportional whether the editor is showing a small zoom or full size.
  const pillPadX = Math.round(fontSize * 0.12);
  const pillPadY = Math.round(fontSize * 0.04);
  const pillRadius = Math.round(fontSize * 0.18);

  function wordStyle(i: number): React.CSSProperties {
    const isActive = i === activeIdx;
    const isSpoken = i < activeIdx;
    switch (wordHighlight) {
      case "karaoke":
        return {
          color: isActive
            ? activeWordColor
            : isSpoken
              ? spokenWordColor
              : color,
          transition: "color 80ms ease-out",
        };
      case "color":
        return {
          color: isActive ? activeWordColor : color,
          transition: "color 80ms ease-out",
        };
      case "scale":
        return {
          color: isActive ? activeWordColor : color,
          transform: isActive ? "scale(1.15)" : "scale(1)",
          transformOrigin: "center bottom",
          transition: "transform 120ms ease-out, color 80ms ease-out",
        };
      case "background":
        // Padding is applied to every word (active or not) so swapping
        // the active word doesn't push neighbors around — the highlight
        // glides cleanly behind the words instead of reflowing the line.
        // borderRadius is also constant; only `background` toggles.
        return {
          color,
          background: isActive ? activeWordColor : "transparent",
          padding: `${pillPadY}px ${pillPadX}px`,
          borderRadius: pillRadius,
          // The pill takes over the outline visually; drop the stroke on
          // the active word so the glyph reads cleanly against the fill.
          WebkitTextStroke: isActive ? "0" : undefined,
          transition: "background 80ms ease-out",
        };
      default:
        // "none" is handled by the early return above; this branch only
        // fires if the enum grows a new value the renderer doesn't know.
        return { color };
    }
  }

  return (
    <div style={containerStyle}>
      <div style={textBlockStyle}>
        {words.map((w, i) => (
          <span
            key={i}
            style={{
              display: "inline-block",
              marginRight: i < words.length - 1 ? 16 : 0,
              ...wordStyle(i),
            }}
          >
            {w.word}
          </span>
        ))}
      </div>
    </div>
  );
}
