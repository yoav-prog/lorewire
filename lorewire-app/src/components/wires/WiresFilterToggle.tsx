"use client";

// Feed-level filter pill shared by both Wires surfaces (mobile WiresFeed +
// desktop WiresDesktop). Top-center, the IG/TikTok "Following | For You"
// placement, so switching between only-unvoted wires (the default) and the
// full feed is discoverable and one tap away. The wrapper is
// pointer-events-none so ONLY the pill takes taps — the video stage behind
// the empty center stays fully interactive.

interface WiresFilterToggleProps {
  /** True = "Unvoted" is the active segment (feed shows only wires the viewer
   *  hasn't voted on); false = "All". */
  hideVoted: boolean;
  /** Called with the requested hideVoted value when a segment is tapped. */
  onSelect: (hideVoted: boolean) => void;
}

export function WiresFilterToggle({
  hideVoted,
  onSelect,
}: WiresFilterToggleProps) {
  // Position-agnostic pill: the parent (WiresTopControls) places it in the
  // top-center cluster next to the category filter.
  return (
    <div
      role="group"
      aria-label="Filter wires by whether you've voted"
      className="flex items-center rounded-full p-0.5"
      style={{ background: "rgba(0,0,0,.55)", backdropFilter: "blur(6px)" }}
    >
      <FilterSegment
        label="Unvoted"
        active={hideVoted}
        onClick={() => onSelect(true)}
      />
      <FilterSegment
        label="All"
        active={!hideVoted}
        onClick={() => onSelect(false)}
      />
    </div>
  );
}

function FilterSegment({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3.5 py-1 font-mono text-[10.5px] font-bold uppercase tracking-[.16em] transition-colors ${
        active ? "bg-accent text-bg" : "text-ink/70 hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}
