"use client";

// The "Skip intro" pill both players (WireCard + StoryVideo) render while
// playback sits inside the brand-intro window. Visuals live here so the two
// surfaces stay identical; the caller owns positioning via `className`
// (bottom-right over the frame, Netflix-style). Deliberately NOT part of the
// Wires chrome auto-hide group — the button is time-boxed by the intro
// itself and hiding it would defeat its one job.
// Plan: _plans/2026-07-04-skip-intro.md.

const SkipGlyph = ({ size = 14 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden
  >
    <path d="M5 5.5v13l9-6.5z" />
    <path d="M16.5 5h2v14h-2z" />
  </svg>
);

export default function SkipIntroButton({
  onClick,
  className = "",
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      // Pointer events on the Wires stage arbitrate tap-vs-hold gestures;
      // stop them here so pressing the button can't double as a play/pause
      // tap or a press-and-hold pause on the video underneath.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      aria-label="Skip intro"
      className={`flex h-9 items-center gap-1.5 rounded-full pl-3 pr-3.5 text-ink active:scale-95 transition ${className}`}
      style={{
        background: "rgba(0,0,0,.55)",
        backdropFilter: "blur(6px)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,.3)",
      }}
    >
      <SkipGlyph />
      <span className="font-mono text-[10px] font-bold uppercase tracking-[.18em]">
        Skip intro
      </span>
    </button>
  );
}
