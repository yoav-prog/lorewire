// Social-cover poster composition.
//
// Renders a 1080x1920 PNG via Remotion's renderStill, used as the cover
// image for IG / FB / YouTube (once verified) social publishes. The
// composition is intentionally LEAN: scene-1 fills the top 70%, a solid
// dark band fills the bottom 30% with the spoken hook in large display
// typography + a small LoreWire-red brand pill in the corner.
//
// Per _plans/2026-06-28-phase-2-social-poster-render.md (Part 1). The
// design was iterated against 4 real production stories in a PIL preview
// pass before this Remotion port; the visual contract is identical.
//
// IMPORTANT: this is a STILL composition (rendered via renderStill, not
// renderMedia) so there is no audio path, no caption sequence, no frame
// advance. The composition's `durationInFrames=1` because renderStill
// only ever reads frame 0.

import React from "react";
import { AbsoluteFill, Img } from "remotion";
import { loadFont as loadBebasNeue } from "@remotion/google-fonts/BebasNeue";

// Load Bebas Neue at module-import time so the font is registered before
// renderStill rasterizes. Per the council feedback (Outsider voice), the
// Impact/dark-band combo reads as the most overused AI-Shorts-farm pattern
// on the internet; Bebas Neue is the next-nearest condensed-display face
// that doesn't carry the same pattern-match. Same pattern as src/fonts.ts.
const bebasNeue = loadBebasNeue("normal", {
  weights: ["400"],
  subsets: ["latin"],
});
const HOOK_FONT_FAMILY = bebasNeue.fontFamily;

// Brand pill uses the same Inter (already loaded by DoodleShort's render
// path through src/fonts.ts). We don't re-load it here because PosterStill
// is rendered separately via renderStill and the Inter loadFont in
// src/fonts.ts only fires when DoodleShort.tsx imports it. So we use a
// generic system-bold fallback for the pill — it's tiny text and the
// fallback (Arial / sans-serif bold) reads cleanly enough that swapping
// for Inter is a polish item, not a blocker.
const BRAND_FONT_FAMILY =
  '"Inter", system-ui, -apple-system, "Segoe UI", Arial, sans-serif';

// Canvas — IG Reels / YouTube Shorts / TikTok / FB Reels native size.
export const POSTER_WIDTH = 1080;
export const POSTER_HEIGHT = 1920;

// Band geometry. 30% from the bottom matches the PIL preview Yoav signed
// off on. Changing these requires bumping POSTER_VERSION on the cache
// hash (lib/short-poster.ts) so existing posters re-render.
const BAND_HEIGHT = Math.round(POSTER_HEIGHT * 0.30); // 576
const BAND_TOP = POSTER_HEIGHT - BAND_HEIGHT;         // 1344
const ACCENT_STRIPE_H = 8;

// Brand colors. Locked. Bump POSTER_VERSION when touching.
const COLOR_BAND_BG = "#0F172A";        // navy-near-black, matches the on-video caption stroke
const COLOR_ACCENT = "#DC2626";          // LoreWire red
const COLOR_TEXT = "#FFFFFF";
const COLOR_PILL_BG = COLOR_ACCENT;
const COLOR_PILL_TEXT = "#FFFFFF";

// Hook typography. Auto-sized so 2-word hooks (rare, ~"Gone.") punch and
// 12-word hooks still fit without overflowing the band. The bias toward
// the upper end (110pt) reflects the PIL preview's read at grid scale —
// smaller text loses the stop-the-scroll punch.
const HOOK_FONT_SIZE_MAX = 110;
const HOOK_FONT_SIZE_MIN = 58;
const HOOK_LINE_HEIGHT = 1.05;
const HOOK_PADDING_X = 70;
const HOOK_MAX_LINES = 3;

// Brand pill geometry. The pill is intentionally small — the hook is the
// hero, the brand is a signature.
const BRAND_TEXT = "LORE WIRE";
const BRAND_FONT_SIZE = 34;
const BRAND_PILL_PADX = 22;
const BRAND_PILL_PADY = 12;
const BRAND_PILL_RADIUS = 24;
const BRAND_MARGIN = 36;

// Strict prop shape. The Cloud Run /render-poster endpoint validates
// the inputProps body against the same caps documented here before
// calling selectComposition.
//
// `text` is the climax-revealing line the helper already resolved
// before calling Cloud Run — `lib/short-poster.ts::ensureShortPoster`
// picks between the cached `short_config.poster_text` (LLM-generated
// at publish time), a freshly-generated line, or the spoken hook as
// a last-ditch fallback. PosterStill itself does NOT pick; it just
// renders. This keeps the social-only LLM call upstream and the
// composition trivially deterministic.
export interface PosterStillProps {
  scene_1_url: string;
  text: string;
  brand_text?: string;
}

// Greedy line-wrap by character budget. Remotion's renderer can't measure
// glyph widths server-side without a layout pass, so we approximate by
// character count at each font tier. The approximation errs on the side
// of LESS text per line, which is the safe direction (slight underfill
// reads as deliberate typography; overflow reads as broken). Per-line
// caps tuned against the PIL preview's 4 real hooks plus 4 synthetic
// edge cases (1-word, 12-word, all-caps source, smart-quote source).
function pickFontSize(text: string): number {
  const len = text.length;
  // Empirical thresholds: each 110pt line fits ~13-14 caps Bebas Neue
  // glyphs at 70px side padding on a 1080-wide canvas. We pick the
  // largest size where the hook fits in <= HOOK_MAX_LINES lines.
  if (len <= 14) return 110;
  if (len <= 28) return 96;
  if (len <= 44) return 82;
  if (len <= 64) return 70;
  return HOOK_FONT_SIZE_MIN;
}

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

function charsPerLineForSize(fontSize: number): number {
  // Bebas Neue is a condensed display face. At 1080-wide, 70px each side
  // padding leaves 940px for glyphs. Average condensed-caps glyph advance
  // is ~ fontSize * 0.42. So chars-per-line ≈ 940 / (fontSize * 0.42).
  return Math.max(8, Math.floor(940 / (fontSize * 0.42)));
}

export const PosterStill: React.FC<PosterStillProps> = ({
  scene_1_url,
  text,
  brand_text,
}) => {
  // Normalize uppercase + trim once so the auto-sizer sees the exact
  // glyph string that will render.
  const hookText = (text || "").trim().toUpperCase();
  const brandText = (brand_text || BRAND_TEXT).toUpperCase();
  const fontSize = pickFontSize(hookText);
  const charsPerLine = charsPerLineForSize(fontSize);
  const lines = wrapLines(hookText, charsPerLine).slice(0, HOOK_MAX_LINES);
  // If wrapLines exceeded the cap, ellipsize the last line so the truncation
  // is visible instead of silent.
  if (
    lines.length === HOOK_MAX_LINES &&
    wrapLines(hookText, charsPerLine).length > HOOK_MAX_LINES
  ) {
    const last = lines[HOOK_MAX_LINES - 1].replace(/\s+\S*$/, "");
    lines[HOOK_MAX_LINES - 1] = last.length > 0 ? `${last}…` : "…";
  }

  return (
    <AbsoluteFill style={{ background: COLOR_BAND_BG }}>
      {/* Top region: scene-1 doodle, anchored top so character heads are
          in the visible portion. The band overlay covers what would
          otherwise be the bottom of the scene (usually feet / floor /
          table — least story-critical content). */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: POSTER_WIDTH,
          height: BAND_TOP,
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

      {/* Red accent stripe at the band's top edge. Ties the band into
          the brand color and signals "this is a deliberate composition
          layer, not a letterboxed crop." */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: BAND_TOP,
          width: POSTER_WIDTH,
          height: ACCENT_STRIPE_H,
          background: COLOR_ACCENT,
        }}
      />

      {/* Solid title band. The canvas background is already COLOR_BAND_BG
          but we draw the band explicitly so the design intent reads in
          the composition source. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: BAND_TOP + ACCENT_STRIPE_H,
          width: POSTER_WIDTH,
          height: BAND_HEIGHT - ACCENT_STRIPE_H,
          background: COLOR_BAND_BG,
        }}
      />

      {/* Hook text — centered horizontally + vertically in the band,
          leaving room for the brand pill in the bottom-right corner. */}
      <div
        style={{
          position: "absolute",
          left: HOOK_PADDING_X,
          right: HOOK_PADDING_X,
          top: BAND_TOP + ACCENT_STRIPE_H,
          height: BAND_HEIGHT - ACCENT_STRIPE_H - 90 /* pill row reserve */,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          fontFamily: HOOK_FONT_FAMILY,
          fontSize,
          lineHeight: HOOK_LINE_HEIGHT,
          color: COLOR_TEXT,
          letterSpacing: 1.2,
        }}
      >
        {lines.map((line, i) => (
          <div key={i} style={{ width: "100%" }}>
            {line}
          </div>
        ))}
      </div>

      {/* Brand pill bottom-right. Wordmark in white over a red rounded
          rectangle. Size is intentionally small so the hook stays the
          hero. */}
      <div
        style={{
          position: "absolute",
          right: BRAND_MARGIN,
          bottom: BRAND_MARGIN,
          background: COLOR_PILL_BG,
          color: COLOR_PILL_TEXT,
          fontFamily: BRAND_FONT_FAMILY,
          fontWeight: 700,
          fontSize: BRAND_FONT_SIZE,
          letterSpacing: 1.5,
          padding: `${BRAND_PILL_PADY}px ${BRAND_PILL_PADX}px`,
          borderRadius: BRAND_PILL_RADIUS,
          lineHeight: 1,
        }}
      >
        {brandText}
      </div>
    </AbsoluteFill>
  );
};
