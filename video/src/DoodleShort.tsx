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
import { findActiveWordIndex, splitChunkWords } from "./caption-words";
import { FONT_FAMILY } from "./fonts";
import { MicroWiggle } from "./motion/MicroWiggle";
import { LabelPopOn } from "./motion/LabelPopOn";
import { ScribbleDraw } from "./motion/ScribbleDraw";
import { PropSlideIn } from "./motion/PropSlideIn";
import { MouthSwap } from "./motion/MouthSwap";

// Wrap in staticFile() ONLY for relative paths. The Cloud Run render
// path supplies remote GCS URLs directly; passing those to staticFile()
// throws TypeError per the Remotion contract — staticFile() is for
// files inside `public/`. The CLI render path historically passed
// staticFile-style basenames which still pass through unchanged.
function assetSrc(url: string): string {
  return /^(?:https?:)?\/\//.test(url) ? url : staticFile(url);
}
import { useCompositionScale } from "./scale";
import type {
  ShortCaptionChunk,
  ShortCaptionWord,
  ShortVideoConfig,
} from "./types";

export const DoodleShort: React.FC<ShortVideoConfig> = (config) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  // Phase 1 of _plans/2026-06-12-video-aspect-ratio.md: every hardcoded
  // "px" value in this composition was authored against the 1080x1920
  // portrait baseline. `scaleW` / `scaleH` map a base-px to the current
  // canvas so 16:9 (1920x1080) renders look like the portrait does — wider
  // canvas gets bigger fonts + paddings; shorter canvas gets tighter
  // top/bottom insets. Identity for portrait so back-compat holds.
  //
  // Caption text uses `scaleMin` (the smaller of the two ratios). Scaling
  // the type by canvas width inflates a 96 px portrait font to 171 px on
  // landscape — far too tall for the 1080-px-high landscape frame, which
  // is why a 4-word chunk like "BY FRIDAY THE OFFICE" wraps to two lines
  // and dominates the frame. The captions are a fixed-aspect visual
  // element (same reason `scaleMin` already governs prop cards + the
  // talking-head bust), so they should track the smaller axis.
  const { scaleW, scaleH, scaleMin } = useCompositionScale();

  // Trim window. Both bounds are absolute against the unclipped audio /
  // caption timeline; missing means "no trim, render the full thing". The
  // composition's durationInFrames already reflects (clip_end - clip_start)
  // courtesy of calculateMetadata in Root.tsx, so internally we shift every
  // timestamp from absolute → trimmed-relative.
  const clipStartMs = config.clip_start_ms ?? 0;
  const clipEndMs = config.clip_end_ms ?? config.duration_ms;
  const clipStartFrames = Math.round((clipStartMs / 1000) * fps);
  const elapsedMs = (frame / fps) * 1000 + clipStartMs;

  // Wave 3 Phase 1: resolve the caption template once so every chunk render
  // shares the same style object. Missing fields fall back to the original
  // doodle-yellow defaults so renders without an admin override are unchanged.
  const captionTemplate = resolveCaptionTemplate(config.caption_template);

  // Map each doodle frame to a Sequence window. Frame i runs from its caption
  // chunk's start_ms until frame (i+1)'s caption.start_ms (or the end of the
  // composition for the last frame). After deriving the absolute window we
  // subtract clipStartFrames so the Sequence lands at the right spot in the
  // trimmed timeline, and we drop any window that ends before the clip or
  // starts after it.
  const rawFrames = config.doodle_frames;
  const frameWindows = rawFrames
    .map((f, i) => {
      const captionForFrame = config.captions[f.caption_chunk_start_index];
      const startMs = captionForFrame?.start_ms ?? 0;
      const nextFrame = rawFrames[i + 1];
      const nextStartMs = nextFrame
        ? config.captions[nextFrame.caption_chunk_start_index]?.start_ms ??
          clipEndMs
        : clipEndMs;
      const absoluteFromFrames = Math.max(0, Math.round((startMs / 1000) * fps));
      const lengthFrames = Math.max(
        1,
        Math.round(((nextStartMs - startMs) / 1000) * fps),
      );
      return { f, absoluteFromFrames, lengthFrames, startMs, nextStartMs };
    })
    .filter(({ startMs, nextStartMs }) =>
      // Drop windows entirely outside the trim. Boundary windows that
      // straddle the edge survive and get clamped below.
      nextStartMs > clipStartMs && startMs < clipEndMs
    )
    .map(({ f, absoluteFromFrames, lengthFrames }, i) => {
      const fromFrames = Math.max(0, absoluteFromFrames - clipStartFrames);
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
      {config.voiceover_url && (
        // Skip past the trimmed-out head so audio plays from the clip start.
        // When clip_start_ms is 0 (the default), startFrom=0 is a no-op and
        // the render is byte-identical to the pre-trim composition.
        <Audio
          src={assetSrc(config.voiceover_url)}
          startFrom={clipStartFrames}
        />
      )}

      {frameWindows.map((f, i) => (
        <Sequence
          key={`${f.url}-${i}`}
          from={f.fromFrames}
          durationInFrames={f.lengthFrames}
        >
          <MicroWiggle seed={i} enabled={!!config.motion?.micro_wiggle}>
            <DoodleFrameImg
              src={assetSrc(f.url)}
              kenBurns={!!config.ken_burns}
              seed={i}
              lengthFrames={f.lengthFrames}
            />
          </MicroWiggle>
          <ScribbleDraw enabled={!!config.motion?.scribble_draw} seed={i} />
        </Sequence>
      ))}

      {config.title && titleOpacity > 0 && (
        <div
          style={{
            position: "absolute",
            top: scaleH(96),
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            opacity: titleOpacity,
          }}
        >
          <div
            style={{
              fontSize: scaleW(40),
              fontWeight: 800,
              padding: `${scaleH(12)}px ${scaleW(28)}px`,
              borderRadius: scaleW(24),
              background: "rgba(255,255,255,0.92)",
              color: "#0f172a",
              border: `${Math.max(1, scaleW(3))}px solid #0f172a`,
              letterSpacing: -0.5,
              maxWidth: scaleW(900),
              textAlign: "center",
              lineHeight: 1.1,
            }}
          >
            {config.title}
          </div>
        </div>
      )}

      {activeCaption && (
        <DoodleCaption
          caption={activeCaption}
          elapsedMs={elapsedMs}
          style={captionTemplate}
          scaleW={scaleW}
          scaleMin={scaleMin}
        />
      )}

      {activeCaption && activeIndex >= 0 && (
        <LabelPopOn
          enabled={!!config.motion?.label_pop}
          caption={activeCaption}
          index={activeIndex}
        />
      )}

      <PropSlideIn
        enabled={!!config.motion?.prop_slide}
        items={config.props_list ?? []}
        durationMs={config.duration_ms}
      />

      <MouthSwap
        enabled={!!config.motion?.mouth_swap}
        characterUrl={config.character_image_mouth_removed}
        words={config.captions.flatMap((c) => c.words ?? [])}
      />

      {/* Editor overlays — text plates the admin positions on top of the
          composition. Each overlay is a single <Sequence> windowed to its
          [start_ms, end_ms] in the trimmed timeline. Filtered out when
          the trim removes its window; absolute positions are shifted by
          -clipStartFrames the same way frame windows are. */}
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
            <OverlayLayer overlay={o} scaleW={scaleW} scaleH={scaleH} />
          </Sequence>
        );
      })}

      {config.channel_name && (
        <div
          style={{
            position: "absolute",
            bottom: scaleH(96),
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              fontSize: scaleW(28),
              fontWeight: 700,
              padding: `${scaleH(8)}px ${scaleW(22)}px`,
              borderRadius: 999,
              background: "rgba(255,255,255,0.92)",
              color: "#0f172a",
              border: `${Math.max(1, scaleW(2))}px solid #0f172a`,
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
  scaleW: (px: number) => number;
  scaleMin: (px: number) => number;
}> = ({ caption, elapsedMs, style, scaleW, scaleMin }) => {
  const sinceStart = elapsedMs - caption.start_ms;
  const untilEnd = caption.end_ms - elapsedMs;
  const fadeIn = Math.min(1, Math.max(0, sinceStart / CHUNK_FADE_MS));
  const fadeOut = Math.min(1, Math.max(0, untilEnd / CHUNK_FADE_MS));
  const opacity = Math.min(fadeIn, fadeOut);

  // Word-level split. Prefers alignment-derived `caption.words` and falls
  // back to a proportional split so a chunk without alignment still has a
  // usable per-word timeline.
  const words: ShortCaptionWord[] = splitChunkWords(caption);
  const activeIdx =
    style.wordHighlight === "none" ? -1 : findActiveWordIndex(words, elapsedMs);

  // Auto-size: short chunks get bigger type so a 2-word hook punches at the
  // same legibility budget as a 4-word phrase. The admin's size_scale multiplies
  // the base size so a global tweak shifts every chunk together. The base
  // tiers (96 / 80 / 64) were calibrated against the 1080x1920 portrait canvas
  // (96 px = 5 % of frame height); `scaleMin` maps them onto the live canvas so
  // captions occupy the same vertical share on landscape (96 * 0.56 = 54 px on
  // a 1080-tall frame = 5 %). The stroke + shadow track the font so the
  // outline weight stays proportional. Portrait is identity (ratio = 1) so
  // existing renders are byte-identical.
  const wordCount = words.length;
  const baseFontSize = wordCount <= 4 ? 96 : wordCount <= 6 ? 80 : 64;
  const fontSize = Math.round(scaleMin(baseFontSize) * style.sizeScale);
  // Floor the stroke at 5 px because H.264 4:2:0 chroma subsampling can't
  // carry sub-5 px navy/yellow boundaries cleanly across a frame — the
  // encoder smears the high-frequency color transition and the user sees
  // a ghosted second outline alongside the real one. Portrait (ratio = 1)
  // already lands at 6 px so this is a no-op there; landscape sat at
  // 3.36 px without the floor, which is what produced the artifacts.
  const outlineWidth = Math.max(5, scaleMin(style.outlineWidth));

  // wordHighlight === "none": render the chunk as one block, no per-word
  // styling. Used for "I just want the text, no karaoke pulse".
  if (style.wordHighlight === "none" || words.length === 0) {
    return (
      <div
        style={{
          position: "absolute",
          top: `${style.positionY * 100}%`,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          padding: `0 ${scaleW(style.paddingX)}px`,
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
            // Comic outline matching the yt-studio doodle reference exactly
            // (ShortVideo.tsx:581): a single -webkit-text-stroke with
            // paintOrder "stroke fill" so the stroke paints UNDER the fill —
            // the yellow fill is never eroded and there are no spikes. The
            // earlier text-shadow ring deviated from the reference and rendered
            // as lumpy "weird shapes" around the glyphs.
            WebkitTextStroke: `${outlineWidth}px ${style.outlineColor}`,
            paintOrder: "stroke fill",
            maxWidth: "100%",
          }}
        >
          {caption.text}
        </div>
      </div>
    );
  }

  // Per-word render path. Each mode chooses how a single word should look
  // given its position relative to the active index. Background pills get
  // a little extra horizontal padding scaled with the font size so the
  // pill doesn't crowd the glyphs at large sizes.
  const pillPadX = Math.round(fontSize * 0.12);
  const pillPadY = Math.round(fontSize * 0.04);
  const pillRadius = Math.round(fontSize * 0.18);

  function wordStyle(i: number): React.CSSProperties {
    const isActive = i === activeIdx;
    const isSpoken = i < activeIdx;
    switch (style.wordHighlight) {
      case "karaoke":
        return {
          color: isActive
            ? style.activeWordColor
            : isSpoken
              ? style.spokenWordColor
              : style.color,
          transition: "color 80ms ease-out",
        };
      case "color":
        return {
          color: isActive ? style.activeWordColor : style.color,
          transition: "color 80ms ease-out",
        };
      case "scale":
        return {
          color: isActive ? style.activeWordColor : style.color,
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
          color: style.color,
          background: isActive ? style.activeWordColor : "transparent",
          padding: `${pillPadY}px ${pillPadX}px`,
          borderRadius: pillRadius,
          // The pill takes over the outline visually; drop the stroke on
          // the active word so the glyph reads cleanly against the fill.
          WebkitTextStroke: isActive ? "0" : undefined,
          transition: "background 80ms ease-out",
        };
      default:
        // "none" is handled by the early return above, but ResolvedTemplate
        // types wordHighlight as a string-union and TS can't narrow through
        // the closure — keep an explicit fallback so the component never
        // returns undefined if the enum grows a new value.
        return { color: style.color };
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        top: `${style.positionY * 100}%`,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        padding: `0 ${scaleW(style.paddingX)}px`,
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
          // Comic outline matching the yt-studio doodle reference
          // (ShortVideo.tsx:581): -webkit-text-stroke with paintOrder
          // "stroke fill" (stroke painted under the fill — clean edge, no
          // eroded fill, no "weird shapes").
          WebkitTextStroke: `${outlineWidth}px ${style.outlineColor}`,
          paintOrder: "stroke fill",
          maxWidth: "100%",
        }}
      >
        {words.map((w, i) => (
          <span
            key={i}
            style={{
              display: "inline-block",
              marginRight: i < words.length - 1 ? scaleMin(16) : 0,
              ...wordStyle(i),
            }}
          >
            {w.word}
          </span>
        ))}
      </div>
    </div>
  );
};

// Single overlay layer. Plain white text with a heavy shadow so it reads
// against any background (doodle bg #fbfaf4 OR a photo frame). Position
// is anchored at the overlay's (x, y) — translate(-50%, -50%) centers the
// box around that point so an overlay at (0.5, 0.5) is dead-center even
// at long text lengths.
const OverlayLayer: React.FC<{
  overlay: { start_ms: number; end_ms: number; text: string; x: number; y: number };
  scaleW: (px: number) => number;
  scaleH: (px: number) => number;
}> = ({ overlay, scaleW, scaleH }) => {
  const shadowBlur = scaleW(12);
  const shadowOffset = scaleW(4);
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
          fontSize: scaleW(56),
          fontWeight: 800,
          color: "#fbfaf4",
          textAlign: "center",
          lineHeight: 1.1,
          textShadow: [
            `0 0 ${shadowBlur}px rgba(15, 23, 42, 0.85)`,
            `0 ${shadowOffset}px 0 #0f172a`,
            `0 -${shadowOffset}px 0 #0f172a`,
            `${shadowOffset}px 0 0 #0f172a`,
            `-${shadowOffset}px 0 0 #0f172a`,
          ].join(", "),
          padding: `${scaleH(8)}px ${scaleW(16)}px`,
        }}
      >
        {overlay.text}
      </div>
    </div>
  );
};
