// Corner meta chips shared by both PosterArt implementations (mobile
// AppShell + DesktopShell). Replaces the old top-row pair where the
// category label and the duration badge fought over the same ~132px
// strip: granular labels like "Money & Inheritance" are up to 20
// characters, which at 9px mono + .18em tracking is wider than a whole
// mobile poster, so the label wrapped into the duration badge
// (_plans/2026-07-02-poster-meta-corner-split.md).
//
// The fix is a corner split — the two chips can never collide because
// they no longer share an axis:
//   - Category: top-left, alone on its row so long labels fit on one
//     line. A 2px left border in the category colour keys the chip to
//     the taxonomy without the width cost of a dot + gap. `truncate`
//     is the safety net for admin-added labels longer than the card.
//   - Duration: bottom-right, the universal video-thumbnail position
//     (YouTube/TikTok), over the artwork's existing bottom gradient.
//
// Client-safe: pure presentational JSX + the client-safe visuals data.
// No hooks, no server imports — safe to import from any shell.

import { categoryVisual } from "@/lib/categories/visuals";

export default function PosterMeta({ cat, dur }: { cat?: string; dur?: string }) {
  const color = cat ? categoryVisual(cat).color : null;
  return (
    <>
      {cat && (
        <div className="absolute left-2 top-2 z-10 max-w-[calc(100%-16px)]">
          <span
            className="block truncate rounded bg-black/65 font-mono uppercase text-white/95 backdrop-blur-sm"
            style={{ fontSize: 8, letterSpacing: ".07em", padding: "3px 6px", borderLeft: `2px solid ${color}` }}
          >
            {cat}
          </span>
        </div>
      )}
      {dur && (
        <div
          className="absolute right-2 bottom-2 z-10 rounded bg-black/65 font-mono tabular-nums text-white/95 backdrop-blur-sm"
          style={{ fontSize: 9, letterSpacing: ".04em", padding: "2px 6px" }}
        >
          {dur}
        </div>
      )}
    </>
  );
}
