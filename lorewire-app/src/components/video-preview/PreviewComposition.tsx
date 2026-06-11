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
//
// What it deliberately DOESN'T:
//   - Karaoke per-word highlight
//   - Motion beats (MicroWiggle, ScribbleDraw, PropSlideIn, MouthSwap, LabelPopOn)
//   - Ken-Burns pan/zoom
//   - Intro/outro splice (those happen after the body render)
//
// Editors that need exact frame fidelity should hit "Render" — the queued
// MP4 is the canonical output.

import {
  AbsoluteFill,
  Audio,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { ShortVideoConfig } from "@/lib/video-config";

const TITLE_VISIBLE_MS = 1200;
const TITLE_FADE_MS = 600;
const CHUNK_FADE_MS = 80;

// Props the editor passes. We keep ShortVideoConfig as a typed slot and
// add a parallel `frameUrls` array — the server resolves each
// doodle_frame.url to an absolute browser URL so the preview can <img> them
// directly without going through Remotion's staticFile resolver.
export interface PreviewProps extends Record<string, unknown> {
  config: ShortVideoConfig;
  frameUrls: string[];
  audioUrl: string | null;
}

interface FrameWindow {
  url: string;
  fromFrames: number;
  lengthFrames: number;
}

export function PreviewComposition({
  config,
  frameUrls,
  audioUrl,
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
        <CaptionBand caption={activeCaption} elapsedMs={elapsedMs} />
      )}

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

function CaptionBand({
  caption,
  elapsedMs,
}: {
  caption: { start_ms: number; end_ms: number; text: string };
  elapsedMs: number;
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

  return (
    <div
      style={{
        position: "absolute",
        top: "55%",
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        padding: "0 64px",
        opacity,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          fontSize: 88,
          fontWeight: 900,
          fontFamily: "Arial Black, Arial, sans-serif",
          textTransform: "uppercase",
          letterSpacing: -0.5,
          lineHeight: 1.05,
          textAlign: "center",
          color: "#facc15",
          WebkitTextStroke: "6px #0f172a",
          textShadow:
            "0 0 1px #0f172a, 0 4px 0 #0f172a, 0 -4px 0 #0f172a, 4px 0 0 #0f172a, -4px 0 0 #0f172a",
          maxWidth: "100%",
        }}
      >
        {caption.text}
      </div>
    </div>
  );
}
