// Social-cover poster composition.
//
// Renders a 1080x1920 PNG via Remotion's renderStill, used as the cover
// image for IG / FB / YouTube (once verified) social publishes.
//
// Per _plans/2026-06-30-editorial-poster-redesign.md: the portrait
// composition now reads as a premium editorial cover — warm-dark
// header (top 28%) with a gold-trimmed editorial frame + a serif
// hook + one red brush-script emphasis word, scene illustration
// filling the bottom 72%. The text never overlaps the image — a
// platform-cropping defense, since TikTok / IG Reels / YT Shorts
// all overlay UI on the BOTTOM of the canvas (where the previous
// dark-band layout used to live).
//
// Per _plans/2026-06-28-phase-2-social-poster-render.md (Part 1) — the
// portrait was the first composition rendered via this seam; the
// renderStill / Cloud Run / cache-hash plumbing in the rest of the
// repo is unchanged.
//
// IMPORTANT: this is a STILL composition (rendered via renderStill, not
// renderMedia) so there is no audio path, no caption sequence, no frame
// advance. The composition's `durationInFrames=1` because renderStill
// only ever reads frame 0.

import React from "react";
import { AbsoluteFill, Img } from "remotion";
import { loadFont as loadBebasNeue } from "@remotion/google-fonts/BebasNeue";
import { loadFont as loadPlayfairDisplay } from "@remotion/google-fonts/PlayfairDisplay";
import { loadFont as loadCaveatBrush } from "@remotion/google-fonts/CaveatBrush";

// Portrait fonts — load at module-import time so they're registered
// before renderStill rasterizes. Loaders return synchronously and
// Remotion's renderer awaits the underlying font promises automatically.
//
//   Playfair Display 900 — non-emphasis hook lines (cream black-weight
//                          serif). Yoav's reference cover reads as a
//                          heavy near-Trajan roman; Playfair 900 is
//                          the closest free face that holds its
//                          strokes at thumbnail size.
//   Caveat Brush         — emphasis word (red brush-painted).
const playfair = loadPlayfairDisplay("normal", {
  weights: ["900"],
  subsets: ["latin"],
});
const caveatBrush = loadCaveatBrush("normal", {
  weights: ["400"],
  subsets: ["latin"],
});
const SERIF_FONT_FAMILY = playfair.fontFamily;
const BRUSH_FONT_FAMILY = caveatBrush.fontFamily;

// Landscape OG poster (PosterStillLandscape, further down this file)
// still uses Bebas Neue. Keeping it loaded here because both
// compositions share the same Webpack bundle on Cloud Run.
const bebasNeue = loadBebasNeue("normal", {
  weights: ["400"],
  subsets: ["latin"],
});
const LS_HOOK_FONT_FAMILY = bebasNeue.fontFamily;

// Canvas — IG Reels / YouTube Shorts / TikTok / FB Reels native size.
export const POSTER_WIDTH = 1080;
export const POSTER_HEIGHT = 1920;

// Header geometry. 36% from the top so the heavy serif + brush
// emphasis read at the scale Yoav's reference signed off on
// (smaller header crushed the typography). Bumping this requires a
// POSTER_VERSION bump on the cache hash (lib/short-poster.ts) so
// existing posters re-render.
const HEADER_RATIO = 0.36;
const HEADER_HEIGHT = Math.round(POSTER_HEIGHT * HEADER_RATIO); // 691
const IMAGE_TOP = HEADER_HEIGHT;
const IMAGE_HEIGHT = POSTER_HEIGHT - HEADER_HEIGHT;             // 1229

// Gold inner frame inset. The frame is a thin gold rectangle inside
// the header — top, bottom, left, right strokes plus four corner
// diamond glyphs.
const FRAME_INSET_X = 36;
const FRAME_INSET_Y = 34;
const FRAME_STROKE = 2;
const CORNER_DIAMOND_SIZE = 12;
const DIVIDER_CENTER_DIAMOND_SIZE = 26;

// Gold divider between header and image.
const DIVIDER_HEIGHT = 3;

// Color tokens. Locked. Bump POSTER_VERSION when touching.
const COLOR_HEADER_BG = "#120A06";        // flat warm-near-black; matches
                                           // Yoav's reference (gradient on
                                           // a 1080-wide PNG band as
                                           // 1-bit dither on R2's PNG
                                           // settings, so flat is safer).
const COLOR_GOLD = "#C9A96A";              // editorial gold
const COLOR_GOLD_DARK = "#8A7240";         // gold shadow for corner depth
const COLOR_SERIF = "#F4ECD8";             // warm cream
const COLOR_BRUSH = "#D62828";             // saturated crimson — matches the
                                            // vivid brushstroke red in
                                            // Yoav's reference cover (the
                                            // earlier #C5302C read as muted
                                            // brick at thumbnail scale)
const COLOR_CANVAS_BG = "#0A0604";         // shows briefly while Img loads

// Hook typography. Serif auto-sizes so a 2-word hook punches and a
// 60-char hook still wraps cleanly inside the gold frame. The brush
// scales with the serif but is capped by the emphasis word's length
// so e.g. "everything" doesn't blow past the frame edges. Sizes are
// tuned at Playfair Display 900 (black weight) — strokes hold at
// thumbnail scale across IG / TikTok / YT Shorts.
const SERIF_LINE_HEIGHT = 1.02;
const BRUSH_LINE_HEIGHT = 0.92;
const HOOK_MAX_SERIF_LINES = 3;
const HOOK_TEXT_INSET = 18; // inside the gold frame, both sides
const BRUSH_GAP_PX = 4;
const BRUSH_ROTATE_DEG = -2; // subtle hand-painted bleed

// Hook text region width = canvas width - 2*(frame inset + text inset)
const HOOK_TEXT_WIDTH =
  POSTER_WIDTH - (FRAME_INSET_X + HOOK_TEXT_INSET) * 2;

// Strict prop shape. The Cloud Run /render-poster endpoint validates
// the inputProps body against the same caps documented here before
// calling selectComposition.
//
// `text` is the climax-revealing line the helper already resolved
// before calling Cloud Run — `lib/short-poster.ts::ensureShortPoster`
// picks between the cached `short_config.poster_text` (LLM-generated
// at publish time), a freshly-generated line, or the spoken hook as
// a last-ditch fallback. PosterStill itself does NOT pick; it just
// renders. The composition splits the resolved text into a serif
// block + brush emphasis at render time — see splitEmphasisHook.
export interface PosterStillProps {
  scene_1_url: string;
  text: string;
  brand_text?: string;
}

// ─── Hook splitter ────────────────────────────────────────────────────────────
//
// The editorial design emphasizes ONE word of the hook in red brush
// script. We don't ask the LLM to mark the word (would churn the
// already-tested generatePosterText prompt + the existing cached
// short_config.poster_text rows wouldn't have markup), so we pick
// deterministically: the last whitespace-delimited token after
// trailing-punctuation strip.
//
// This works because every poster_text the LLM generates is structured
// "<setup> <emotional payload>." — the payload is always the final
// noun/verb, e.g. "Her wedding dress was DESTROYED.", "Eight hundred
// dollars. GONE.", "She found the joint account drained to zero
// OVERNIGHT.". The spoken-hook fallback follows the same shape (it
// IS a stop-the-scroll line written for the same purpose). So
// "last word" reliably hits the emphasis word for ~every production
// hook in the cache today.
//
// Edge cases the splitter handles, all covered by unit tests:
//   - empty / whitespace-only        -> { serifLines: [], emphasis: null }
//   - single word                    -> { serifLines: [], emphasis: word }
//   - trailing `.`, `!`, `?`, `…`    -> stripped before tokenizing
//   - smart quotes / curly punct.    -> preserved inside words
//   - double-space between words     -> normalized

const TRAILING_PUNCT_RE = /[.!?…]+$/;
const SERIF_TAIL_PUNCT_RE = /[.,;:]+$/;

export interface HookParts {
  /** Lines of the non-emphasis serif block, in render order.
   *  Empty array when the whole hook is a single emphasis word. */
  serifLines: string[];
  /** The brushed red word that renders on its own line below the
   *  serif. Null when the hook is empty / unrenderable. */
  emphasis: string | null;
}

/** Split the hook into a serif block + a single brush-emphasis word.
 *  Exported for unit tests; the composition is the only caller. */
export function splitEmphasisHook(
  rawHook: string,
  charsPerSerifLine: number,
): HookParts {
  const trimmed = (rawHook ?? "").trim();
  if (!trimmed) return { serifLines: [], emphasis: null };

  // Strip ALL trailing terminal punctuation so the emphasis word is
  // tokenized cleanly. "destroyed." -> "destroyed", "Gone…" -> "Gone".
  const noTail = trimmed.replace(TRAILING_PUNCT_RE, "").trimEnd();
  if (!noTail) return { serifLines: [], emphasis: null };

  const tokens = noTail.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { serifLines: [], emphasis: null };
  if (tokens.length === 1) {
    return { serifLines: [], emphasis: tokens[0] };
  }

  const emphasis = tokens[tokens.length - 1];
  // Strip trailing inline punctuation off the serif remainder so we
  // don't double-punctuate ("Her wedding dress was, destroyed" would
  // render as "Her wedding dress was   destroyed").
  const remainder = tokens
    .slice(0, -1)
    .join(" ")
    .replace(SERIF_TAIL_PUNCT_RE, "");
  const lines = wrapLines(remainder, charsPerSerifLine).slice(
    0,
    HOOK_MAX_SERIF_LINES,
  );
  return { serifLines: lines, emphasis };
}

// Greedy line-wrap by character budget. Remotion's renderer can't
// measure glyph widths server-side without a layout pass, so we
// approximate by character count at each font tier. The approximation
// errs on the side of LESS text per line, which is the safe direction
// (slight underfill reads as deliberate typography; overflow reads as
// broken).
function wrapLines(text: string, charsPerLine: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length <= charsPerLine || !cur) {
      cur = candidate;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ─── Portrait auto-sizers ─────────────────────────────────────────────────────
//
// Empirical tiers tuned for Playfair Display Bold at the editorial
// header's text region width (~830 px after the gold frame + text
// inset). Each tier picks the largest serif size where the hook still
// fits within HOOK_MAX_SERIF_LINES lines. Brush scales with the
// serif but is capped per-character so a long emphasis word can't
// overflow.

function pickSerifFontSize(hook: string): number {
  const len = hook.length;
  // Tiers are dramatically larger than the original Phase 2 pass —
  // Yoav's reference cover wants the serif to fill the header at
  // thumbnail scale (the prior 66pt tier-3 read as captions, not as
  // editorial typography). At 110pt Playfair 900 the strokes still
  // anti-alias cleanly down to a 540 px IG grid thumb.
  if (len <= 14) return 140;
  if (len <= 28) return 120;
  if (len <= 44) return 108;
  if (len <= 60) return 88;
  if (len <= 80) return 70;
  return 58;
}

function charsPerLineForSerifSize(fontSize: number): number {
  // Playfair Display 900 has ~0.52 average glyph advance / em at
  // mixed case (the editorial design does NOT uppercase). Region
  // width below comes from HOOK_TEXT_WIDTH.
  return Math.max(6, Math.floor(HOOK_TEXT_WIDTH / (fontSize * 0.52)));
}

function pickBrushFontSize(serifSize: number, emphasis: string): number {
  // Brush is ~2.4× the serif — this is the stop-the-scroll word, it
  // has to dominate the cover the way "destroyed" does in Yoav's
  // reference. Cap by emphasis-word length so "everything" doesn't
  // blow past the gold frame. Caveat Brush is a script face with
  // tight, slanted glyph advances (~0.40 em — narrower than the
  // block-typography estimate I started with), so the cap admits a
  // larger size than the same word in a non-script font.
  const base = Math.round(serifSize * 2.4);
  const capByWidth = Math.floor(
    HOOK_TEXT_WIDTH / (Math.max(2, emphasis.length) * 0.40),
  );
  return Math.max(120, Math.min(base, capByWidth, 340));
}

// ─── Portrait composition ─────────────────────────────────────────────────────

export const PosterStill: React.FC<PosterStillProps> = ({
  scene_1_url,
  text,
}) => {
  const serifSize = pickSerifFontSize((text ?? "").trim());
  const charsPerLine = charsPerLineForSerifSize(serifSize);
  const { serifLines, emphasis } = splitEmphasisHook(text ?? "", charsPerLine);
  const brushSize = emphasis ? pickBrushFontSize(serifSize, emphasis) : 0;

  // Corner diamond positions — centered on the four inner corners of
  // the gold frame.
  const cornerPositions: Array<{ left: number; top: number }> = [
    { left: FRAME_INSET_X, top: FRAME_INSET_Y },
    { left: POSTER_WIDTH - FRAME_INSET_X, top: FRAME_INSET_Y },
    { left: FRAME_INSET_X, top: HEADER_HEIGHT - FRAME_INSET_Y },
    {
      left: POSTER_WIDTH - FRAME_INSET_X,
      top: HEADER_HEIGHT - FRAME_INSET_Y,
    },
  ];

  return (
    <AbsoluteFill style={{ background: COLOR_CANVAS_BG }}>
      {/* Header band: flat warm-near-black editorial background. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: POSTER_WIDTH,
          height: HEADER_HEIGHT,
          background: COLOR_HEADER_BG,
        }}
      />

      {/* Image area — scene_1 below the header, unobstructed. Anchor
          top so character heads land in the visible portion (the
          source image is portrait 9:16 too, so cover cropping shaves
          the bottom — feet / floor — which is what we want). */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: IMAGE_TOP,
          width: POSTER_WIDTH,
          height: IMAGE_HEIGHT,
          overflow: "hidden",
          background: COLOR_CANVAS_BG,
        }}
      >
        <Img
          src={scene_1_url}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center 25%",
          }}
        />
      </div>

      {/* Gold inner frame: four strokes + four corner diamonds. The
          inset-from-edge geometry survives every platform's safe-area
          crop — TikTok eats ~80 px at the top, well inside the
          FRAME_INSET_Y margin. */}
      <div
        style={{
          position: "absolute",
          left: FRAME_INSET_X,
          width: POSTER_WIDTH - FRAME_INSET_X * 2,
          top: FRAME_INSET_Y,
          height: FRAME_STROKE,
          background: COLOR_GOLD,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: FRAME_INSET_X,
          width: POSTER_WIDTH - FRAME_INSET_X * 2,
          top: HEADER_HEIGHT - FRAME_INSET_Y - FRAME_STROKE,
          height: FRAME_STROKE,
          background: COLOR_GOLD,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: FRAME_INSET_X,
          width: FRAME_STROKE,
          top: FRAME_INSET_Y,
          height: HEADER_HEIGHT - FRAME_INSET_Y * 2,
          background: COLOR_GOLD,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: POSTER_WIDTH - FRAME_INSET_X - FRAME_STROKE,
          width: FRAME_STROKE,
          top: FRAME_INSET_Y,
          height: HEADER_HEIGHT - FRAME_INSET_Y * 2,
          background: COLOR_GOLD,
        }}
      />
      {cornerPositions.map((p, i) => (
        <div
          key={`corner-${i}`}
          style={{
            position: "absolute",
            left: p.left - CORNER_DIAMOND_SIZE / 2,
            top: p.top - CORNER_DIAMOND_SIZE / 2,
            width: CORNER_DIAMOND_SIZE,
            height: CORNER_DIAMOND_SIZE,
            background: COLOR_GOLD,
            transform: "rotate(45deg)",
          }}
        />
      ))}

      {/* Hook block: serif lines stacked, brush emphasis on its own
          line below. Fills the entire inner gold frame area — no
          wordmark above. Centered horizontally and vertically. */}
      <div
        style={{
          position: "absolute",
          left: FRAME_INSET_X + HOOK_TEXT_INSET,
          width: HOOK_TEXT_WIDTH,
          top: FRAME_INSET_Y,
          height: HEADER_HEIGHT - FRAME_INSET_Y * 2,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
        }}
      >
        {serifLines.map((line, i) => (
          <div
            key={`serif-${i}`}
            style={{
              fontFamily: SERIF_FONT_FAMILY,
              fontWeight: 900,
              fontSize: serifSize,
              lineHeight: SERIF_LINE_HEIGHT,
              letterSpacing: 0.4,
              color: COLOR_SERIF,
              width: "100%",
            }}
          >
            {line}
          </div>
        ))}
        {emphasis && (
          <div
            style={{
              fontFamily: BRUSH_FONT_FAMILY,
              fontWeight: 400,
              fontSize: brushSize,
              lineHeight: BRUSH_LINE_HEIGHT,
              color: COLOR_BRUSH,
              marginTop: serifLines.length > 0 ? BRUSH_GAP_PX : 0,
              transform: `rotate(${BRUSH_ROTATE_DEG}deg)`,
              width: "100%",
            }}
          >
            {emphasis}
          </div>
        )}
      </div>

      {/* Gold divider between header and image area, with a small
          center diamond. The diamond sits centered on the divider
          line and is filled gold with a darker gold edge for depth. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: HEADER_HEIGHT - DIVIDER_HEIGHT / 2,
          height: DIVIDER_HEIGHT,
          background: COLOR_GOLD,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: POSTER_WIDTH / 2 - DIVIDER_CENTER_DIAMOND_SIZE / 2,
          top: HEADER_HEIGHT - DIVIDER_CENTER_DIAMOND_SIZE / 2,
          width: DIVIDER_CENTER_DIAMOND_SIZE,
          height: DIVIDER_CENTER_DIAMOND_SIZE,
          background: COLOR_GOLD,
          transform: "rotate(45deg)",
          boxShadow: `inset 0 0 0 2px ${COLOR_GOLD_DARK}`,
        }}
      />
    </AbsoluteFill>
  );
};

// ─── Phase 3 landscape variant ────────────────────────────────────────────────
//
// _plans/2026-06-29-phase-3-og-poster-cards.md.
//
// Side-by-side composition for the 1200×630 landscape OG-card surface
// (Twitter / X, Facebook, LinkedIn, Slack, Discord, iMessage, WhatsApp).
// Scene-1 on the left ~55%, dark band on the right ~45% carrying the
// hook text + brand pill. Same visual register as the legacy portrait —
// band + brand pill + condensed-caps Bebas Neue — just rotated.
//
// Per _plans/2026-06-30-editorial-poster-redesign.md: this landscape
// composition is INTENTIONALLY UNCHANGED by the portrait editorial
// redesign. The OG card is consumed by crawlers (Twitter, FB, Slack
// preview) with their own visual conventions and a different aspect
// ratio; the editorial frame doesn't map to landscape gracefully.
//
// CRITICAL: this composition does NOT share `pickFontSize` /
// `charsPerLineForSize` with the portrait. Phase 2's heuristics were
// hardcoded for the portrait's 940 px text width; landscape's text
// region is 540 px wide. The Phase 3 council pass flagged that
// reusing them silently overflows the band. Forked into
// `pickFontSizeLandscape` + `charsPerLineForSizeLandscape` with their
// own empirical tiers, validated against the 10-payload PIL preview
// per the local-first protocol.

export const LANDSCAPE_WIDTH = 1200;
export const LANDSCAPE_HEIGHT = 630;

// Landscape-only visual tokens — kept LOCAL to the landscape block so
// the portrait redesign's color edits can't accidentally drift them.
const LS_COLOR_BAND_BG = "#0F172A";
const LS_COLOR_ACCENT = "#DC2626";
const LS_COLOR_TEXT = "#FFFFFF";
const LS_BRAND_FONT_FAMILY =
  '"Inter", system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
const LS_BRAND_TEXT = "LORE WIRE";
const LS_BRAND_FONT_SIZE = 30;
const LS_BRAND_PILL_PADX = 18;
const LS_BRAND_PILL_PADY = 10;
const LS_BRAND_PILL_RADIUS = 20;
const LS_BRAND_MARGIN = 28;

// Geometry. Left 55% is scene-1, right 45% is the dark band. The 8 px
// red accent stripe sits on the band's LEFT edge (where it meets the
// scene) — same brand signal as the legacy portrait, rotated.
const LS_SCENE_WIDTH = Math.round(LANDSCAPE_WIDTH * 0.55); // 660
const LS_BAND_WIDTH = LANDSCAPE_WIDTH - LS_SCENE_WIDTH;    // 540
const LS_BAND_LEFT = LS_SCENE_WIDTH;
const LS_ACCENT_STRIPE_W = 8;
const LS_HOOK_PADDING_X = 32; // narrower band → tighter padding
const LS_HOOK_MAX_LINES = 4;  // taller band → one more line fits
const LS_HOOK_LINE_HEIGHT = 1.05;

// Empirical landscape size tiers. Tuned for ~540 px text region
// after padding. Will be re-validated against 10 real payloads during
// the local-first PIL preview pass; tweak these numbers BEFORE
// shipping if the preview shows tight fits.
function pickFontSizeLandscape(text: string): number {
  const len = text.length;
  if (len <= 12) return 96;
  if (len <= 24) return 80;
  if (len <= 40) return 66;
  if (len <= 60) return 54;
  return 44;
}

function charsPerLineForSizeLandscape(fontSize: number): number {
  // 540 px band width, 32 px each side padding leaves ~476 px for
  // glyphs. Average condensed-caps glyph advance ~ fontSize * 0.42.
  return Math.max(6, Math.floor(476 / (fontSize * 0.42)));
}

export interface PosterStillLandscapeProps {
  scene_1_url: string;
  text: string;
  brand_text?: string;
}

export const PosterStillLandscape: React.FC<PosterStillLandscapeProps> = ({
  scene_1_url,
  text,
  brand_text,
}) => {
  // Normalize uppercase + trim once so the auto-sizer sees the exact
  // glyph string that will render.
  const hookText = (text || "").trim().toUpperCase();
  const brandText = (brand_text || LS_BRAND_TEXT).toUpperCase();
  const fontSize = pickFontSizeLandscape(hookText);
  const charsPerLine = charsPerLineForSizeLandscape(fontSize);
  const lines = wrapLines(hookText, charsPerLine).slice(0, LS_HOOK_MAX_LINES);
  // Same ellipsis-on-overflow as the legacy portrait so silent
  // truncation can't hide behind the band edge.
  if (
    lines.length === LS_HOOK_MAX_LINES &&
    wrapLines(hookText, charsPerLine).length > LS_HOOK_MAX_LINES
  ) {
    const last = lines[LS_HOOK_MAX_LINES - 1].replace(/\s+\S*$/, "");
    lines[LS_HOOK_MAX_LINES - 1] = last.length > 0 ? `${last}…` : "…";
  }

  return (
    <AbsoluteFill style={{ background: LS_COLOR_BAND_BG }}>
      {/* Left region: scene-1 doodle, anchored center so character
          faces stay visible after a horizontal landscape crop. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: LS_SCENE_WIDTH,
          height: LANDSCAPE_HEIGHT,
          overflow: "hidden",
        }}
      >
        <Img
          src={scene_1_url}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center 25%",
          }}
        />
      </div>

      {/* Red accent stripe along the band's LEFT edge (rotation of
          the legacy portrait's top-edge stripe). */}
      <div
        style={{
          position: "absolute",
          left: LS_BAND_LEFT,
          top: 0,
          width: LS_ACCENT_STRIPE_W,
          height: LANDSCAPE_HEIGHT,
          background: LS_COLOR_ACCENT,
        }}
      />

      {/* Solid title band. */}
      <div
        style={{
          position: "absolute",
          left: LS_BAND_LEFT + LS_ACCENT_STRIPE_W,
          top: 0,
          width: LS_BAND_WIDTH - LS_ACCENT_STRIPE_W,
          height: LANDSCAPE_HEIGHT,
          background: LS_COLOR_BAND_BG,
        }}
      />

      {/* Hook text — centered vertically + horizontally in the band,
          reserving the bottom-right for the brand pill. */}
      <div
        style={{
          position: "absolute",
          left: LS_BAND_LEFT + LS_ACCENT_STRIPE_W + LS_HOOK_PADDING_X,
          top: 0,
          width:
            LS_BAND_WIDTH - LS_ACCENT_STRIPE_W - LS_HOOK_PADDING_X * 2,
          height: LANDSCAPE_HEIGHT - 80 /* pill row reserve */,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          textAlign: "left",
          fontFamily: LS_HOOK_FONT_FAMILY,
          fontSize,
          lineHeight: LS_HOOK_LINE_HEIGHT,
          color: LS_COLOR_TEXT,
          letterSpacing: 1.0,
        }}
      >
        {lines.map((line, i) => (
          <div key={i} style={{ width: "100%" }}>
            {line}
          </div>
        ))}
      </div>

      {/* Brand pill bottom-right of the BAND (not the canvas) — same
          visual signature as the legacy portrait, scaled to the
          band's footprint. */}
      <div
        style={{
          position: "absolute",
          right: LS_BRAND_MARGIN,
          bottom: LS_BRAND_MARGIN,
          background: LS_COLOR_ACCENT,
          color: LS_COLOR_TEXT,
          fontFamily: LS_BRAND_FONT_FAMILY,
          fontWeight: 700,
          fontSize: LS_BRAND_FONT_SIZE,
          letterSpacing: 1.3,
          padding: `${LS_BRAND_PILL_PADY}px ${LS_BRAND_PILL_PADX}px`,
          borderRadius: LS_BRAND_PILL_RADIUS,
          lineHeight: 1,
        }}
      >
        {brandText}
      </div>
    </AbsoluteFill>
  );
};
