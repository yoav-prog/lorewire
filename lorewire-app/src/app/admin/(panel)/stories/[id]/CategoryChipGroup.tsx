"use client";

// Category picker for the story edit form. Phase E of the admin UI
// overhaul (_plans/2026-06-12-admin-ui-overhaul.md) introduced the chip
// group; the 2026-07-01 taxonomy arc made it data-driven — the server
// tab passes the ACTIVE `categories` rows down and each chip's tint is
// an inline style derived from the row's hex, because static Tailwind
// `bg-cat-*` classes can't exist for runtime-created categories (they'd
// be purged at build). Mirrors categoryChipStyle in content/ContentList.
//
// Pattern: the chip group holds local state for the current pick AND
// writes that value into a hidden <input name={name}> so the parent
// server-rendered form picks it up when the user clicks Save changes.
// The FormData arrives with category = the display label; saveStory
// validates it against the same DB set and writes the primary
// story_tag alongside stories.category.
//
// A story whose current value sits OUTSIDE the active set (a legacy
// label like "Drama", or a category archived later) renders as an
// extra leading chip: the current value stays visible, and saving an
// untouched form changes nothing.
//
// Accessibility: outer wrapper is role=radiogroup; each chip is a
// button with aria-checked.

import { useState } from "react";
import { categoryVisual } from "@/lib/categories/visuals";

export interface CategoryChipOption {
  /** Display label, also the value saveStory validates and stores. */
  label: string;
  /** Hex like "#C06234", or null for rows seeded without a color. */
  color: string | null;
}

export function CategoryChipGroup({
  name,
  initial,
  options,
}: {
  /** Name of the hidden input the surrounding form reads. */
  name: string;
  /** The story's current category label ("" when uncategorized). */
  initial: string;
  /** Active categories in admin order, from the `categories` table. */
  options: CategoryChipOption[];
}) {
  const [value, setValue] = useState(initial);

  // Keep an out-of-set current value pickable (leading chip) so the
  // admin sees what the story carries today and a no-touch save is a
  // no-op. categoryVisual still knows the legacy six's colors; anything
  // else gets its neutral fallback swatch.
  const chips =
    initial && !options.some((o) => o.label === initial)
      ? [{ label: initial, color: categoryVisual(initial).color }, ...options]
      : options;

  return (
    <div data-testid="category-chip-group">
      <input type="hidden" name={name} value={value} />
      <div
        role="radiogroup"
        aria-label="Category"
        className="flex flex-wrap gap-1.5"
      >
        {chips.map((opt) => {
          const selected = value === opt.label;
          const color = opt.color ?? categoryVisual(opt.label).color;
          return (
            <button
              key={opt.label}
              type="button"
              role="radio"
              aria-checked={selected}
              data-cat={opt.label}
              onClick={() => setValue(opt.label)}
              // "66"/"26" are the 40%/15% alpha suffixes the legacy
              // --color-cat-* classes used.
              style={
                selected
                  ? {
                      borderColor: `${color}66`,
                      backgroundColor: `${color}26`,
                    }
                  : undefined
              }
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
                selected
                  ? "text-ink"
                  : "border-line bg-bg text-muted hover:border-ink hover:text-ink"
              }`}
            >
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
