// Pure helpers for the Doodle caption renderer. Ported from yt-studio's
// _reference/youtubestudio/src/remotion/doodle-caption-style.ts with the same
// visual contract (yellow comic-bold, dark outline, karaoke highlight) but
// without the CMS override layer (no captions_config flowing in from the DB).
// All defaults are the values yt-studio shipped after their 2026-06-04 pass.

export interface ResolvedDoodleCaptionStyle {
  fontWeight: number;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  textTransform: "uppercase";
  letterSpacing: number;
  lineHeight: number;
  positionY: number;
  paddingX: number;
  activeWordColor: string;
  spokenWordColor: string;
}

export const DOODLE_CAPTION_STYLE: ResolvedDoodleCaptionStyle = {
  fontWeight: 900,
  color: "#facc15",
  outlineColor: "#0f172a",
  outlineWidth: 6,
  textTransform: "uppercase",
  letterSpacing: -0.5,
  lineHeight: 1.05,
  positionY: 0.55,
  paddingX: 64,
  activeWordColor: "#ffffff",
  spokenWordColor: "rgba(250, 204, 21, 0.45)",
};

// Each caption chunk fades in over 80 ms and out over 80 ms; the
// composition adds these to the karaoke effect so the band feels alive
// without distracting from the per-word highlight.
export const CHUNK_FADE_MS = 80;

// Title chip at the top is visible for the hook (first 1.2 s) and fades
// out over 0.6 s after. Keeps it out of the way of the caption line.
export const TITLE_VISIBLE_MS = 1200;
export const TITLE_FADE_MS = 600;
