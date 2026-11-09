"use client";

// The top-center control cluster shared by both Wires surfaces (mobile
// WiresFeed + desktop WiresDesktop): the Unvoted/All filter pill next to the
// category filter funnel. Rendered once per feed so it stays put across cards
// and through the loading / empty states. The wrapper is pointer-events-none so
// only the controls themselves take taps — the video behind them stays
// interactive.

import { WiresFilterToggle } from "@/components/wires/WiresFilterToggle";
import { WireCategoryFilter } from "@/components/wires/WireCategoryFilter";

export interface WiresTopControlsProps {
  /** Unvoted/All: true = only-unvoted is active. */
  hideVoted: boolean;
  onSelectFilter: (hideVoted: boolean) => void;
  /** Category filter: selected granular slugs + mutators. */
  selectedCategories: string[];
  onToggleCategory: (slug: string) => void;
  onClearCategories: () => void;
  /** Drives the category panel presentation: bottom sheet vs anchored popover. */
  variant?: "mobile" | "desktop";
}

export function WiresTopControls({
  hideVoted,
  onSelectFilter,
  selectedCategories,
  onToggleCategory,
  onClearCategories,
  variant = "mobile",
}: WiresTopControlsProps) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-50 flex justify-center"
      style={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)" }}
    >
      <div className="pointer-events-auto flex items-center gap-2">
        <WiresFilterToggle hideVoted={hideVoted} onSelect={onSelectFilter} />
        <WireCategoryFilter
          selected={selectedCategories}
          onToggle={onToggleCategory}
          onClear={onClearCategories}
          variant={variant}
        />
      </div>
    </div>
  );
}
