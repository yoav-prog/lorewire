// Vertical 1080x1920 doodle short composition. Ported from yt-studio's
// DoodleShortVideo (_reference/youtubestudio/src/remotion/compositions/ShortVideo.tsx:357)
// with the same visual contract — full-bleed image sequences, fading title chip,
// yellow comic-bold karaoke caption band, bottom channel pill — but driven from
// LoreWire's simpler input shape (4 generated images + ElevenLabs/Google narration
// + word-level alignment, no production-doc data model and no i2v variants yet).

import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  DOODLE_CAPTION_STYLE,
  CHUNK_FADE_MS,
  TITLE_VISIBLE_MS,
  TITLE_FADE_MS,
  resolveCaptionTemplate,
  type ResolvedTemplate,
} from "./caption-style";
import { findActiveWordIndex } from "./caption-words";
import { FONT_FAMILY } from "./fonts";
import type {
  ShortCaptionChunk,
  ShortCaptionWord,
  ShortVideoConfig,
} from "./types";

export const DoodleShort: React.FC<ShortVideoConfig> = (config) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const elapsedMs = (frame / fps) * 1000;

  // Wave 3 Phase 1: resolve the caption template once so every chunk render
  // shares the same style object. Missing fields fall back to the original
  // doodle-yellow defaults so renders without an admin override are unchanged.
  const captionTemplate = resolveCaptionTemplate(config.caption_template);

  // Map each doodle frame to a Sequence window. Frame i runs from its caption
  // chunk's start_ms until frame (i+1)'s caption.start_ms (or the end of the
  // composition for the last frame). Clamp the tail so the final frame doesn't
  // overrun durationInFrames.
  const rawFrames = config.doodle_frames;
  const frameWindows = rawFrames.map((f, i) => {
    const captionForFrame = config.captions[f.caption_chunk_start_index];
    const startMs = captionForFrame?.start_ms ?? 0;
    const nextFrame = rawFrames[i + 1];
    const nextStartMs = nextFrame
      ? config.captions[nextFrame.caption_chunk_start_index]?.start_ms ??
        config.duration_ms
      : config.duration_ms;
    const fromFrames = Math.max(0, Math.round((startMs / 1000) * fps));
    const lengthFrames = Math.max(
      1,
      Math.round(((nextStartMs - startMs) / 1000) * fps),
    );
    const cappedLength = Math.max(
      1,
      Math.min(lengthFrames, durationInFrames - fromFrames),
    );
    return { ...f, fromFrames, lengthFrames: cappedLength };
  });

  const activeIndex = config.captions.findIndex(
    (c) => elapsedMs >= c.start_ms && elapsedMs < c.end_ms,
  );
  const activeCaption = activeIndex >= 0 ? config.captions[activeIndex] : null;

  const titleOpacity =
    elapsedMs < TITLE_VISIBLE_MS
      ? 1
      : Math.max(0, 1 - (elapsedMs - TITLE_VISIBLE_MS) / TITLE_FADE_MS);

  return (
    <AbsoluteFill
      style={{ background: "#ffffff", fontFamily: FONT_FAMILY }}
    >
      {config.voiceover_url && <Audio src={staticFile(config.voiceover_url)} />}

      {frameWindows.map((f, i) => (
        <Sequence
          key={`${f.url}-${i}`}
          from={f.fromFrames}
          durationInFrames={f.lengthFrames}
        >
          <DoodleFrameImg
            src={staticFile(f.url)}
            kenBurns={!!config.ken_burns}
            seed={i}
            lengthFrames={f.lengthFrames}
          />
        </Sequence>
      ))}

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
        <DoodleCaption caption={activeCaption} elapsedMs={elapsedMs} style={captionTemplate} />
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
};

// Ken-Burns variant: slow scale + pan during each frame's window so 30+ scene
// shorts don't feel static between cuts. Direction varies by frame index for
// visual variety. seed % 4 picks one of (zoom-in, zoom-in + pan-left,
// zoom-in + pan-right, zoom-in + pan-up). All motions are subtle — between
// 6% scale and 4% translate — so the brand still reads as illustration, not
// camera movement.
const DoodleFrameImg: React.FC<{
  src: string;
  kenBurns: boolean;
  seed: number;
  lengthFrames: number;
}> = ({ src, kenBurns, seed, lengthFrames }) => {
  const frame = useCurrentFrame();
  const baseStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
  };
  if (!kenBurns) {
    return <Img src={src} style={baseStyle} />;
  }
  const progress = Math.min(1, Math.max(0, frame / Math.max(1, lengthFrames)));
  const scale = 1 + 0.06 * progress;
  const direction = seed % 4;
  const translateX = direction === 1 ? -4 * progress : direction === 2 ? 4 * progress : 0;
  const translateY = direction === 3 ? -3 * progress : 0;
  return (
    <Img
      src={src}
      style={{
        ...baseStyle,
        transform: `scale(${scale}) translate(${translateX}%, ${translateY}%)`,
        transformOrigin: "center center",
      }}
    />
  );
};

const DoodleCaption: React.FC<{
  caption: ShortCaptionChunk;
  elapsedMs: number;
  style: ResolvedTemplate;
}> = ({ caption, elapsedMs, style }) => {
  const sinceStart = elapsedMs - caption.start_ms;
  const untilEnd = caption.end_ms - elapsedMs;
  const fadeIn = Math.min(1, Math.max(0, sinceStart / CHUNK_FADE_MS));
  const fadeOut = Math.min(1, Math.max(0, untilEnd / CHUNK_FADE_MS));
  const opacity = Math.min(fadeIn, fadeOut);

  // Fall back to evenly-distributed tokens when alignment didn't produce
  // word timings (e.g. STT skipped a chunk). The karaoke effect still has
  // something to track even if the per-word boundaries are approximate.
  const words: ShortCaptionWord[] =
    caption.words && caption.words.length > 0
      ? caption.words
      : proportionalWords(caption);
  const activeIdx =
    style.wordHighlight === "none" ? -1 : findActiveWordIndex(words, elapsedMs);

  // Auto-size: short chunks get bigger type so a 2-word hook punches at the
  // same legibility budget as a 4-word phrase. The admin's size_scale multiplies
  // the base size so a global tweak shifts every chunk together.
  const wordCount = words.length;
  const baseFontSize = wordCount <= 4 ? 96 : wordCount <= 6 ? 80 : 64;
  const fontSize = Math.round(baseFontSize * style.sizeScale);

  return (
    <div
      style={{
        position: "absolute",
        top: `${style.positionY * 100}%`,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        padding: `0 ${style.paddingX}px`,
        opacity,
      }}
    >
      <div
        style={{
          fontSize,
          fontWeight: style.fontWeight,
          fontFamily: FONT_FAMILY,
          textTransform: style.textTransform,
          letterSpacing: style.letterSpacing,
          lineHeight: style.lineHeight,
          textAlign: "center",
          color: style.color,
          WebkitTextStroke: `${style.outlineWidth}px ${style.outlineColor}`,
          textShadow:
            "0 0 1px #0f172a, 0 4px 0 #0f172a, 0 -4px 0 #0f172a, 4px 0 0 #0f172a, -4px 0 0 #0f172a",
          maxWidth: "100%",
        }}
      >
        {words.map((w, i) => (
          <span
            key={i}
            style={{
              color:
                i === activeIdx
                  ? style.activeWordColor
                  : i < activeIdx
                    ? style.spokenWordColor
                    : style.color,
              marginRight: i < words.length - 1 ? 16 : 0,
              display: "inline-block",
              transition: "color 80ms ease-out",
            }}
          >
            {w.word}
          </span>
        ))}
      </div>
    </div>
  );
};

function proportionalWords(caption: ShortCaptionChunk): ShortCaptionWord[] {
  const tokens = caption.text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return [];
  const span = Math.max(1, caption.end_ms - caption.start_ms);
  const per = span / tokens.length;
  return tokens.map((token, i) => ({
    word: token,
    start_ms: Math.round(caption.start_ms + i * per),
    end_ms: Math.round(caption.start_ms + (i + 1) * per),
  }));
}
