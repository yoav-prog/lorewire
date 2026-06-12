"use client";

// Category picker for the story edit form. Phase E of the admin UI
// overhaul (_plans/2026-06-12-admin-ui-overhaul.md): replaces the
// `<select>` dropdown with six visual chips, each tinted by its cat
// color token so the choice is recognisable at a glance.
//
// Pattern: the chip group holds local state for the current pick AND
// writes that value into a hidden <input name={name}> so the parent
// server-rendered form picks it up when the user clicks Save changes.
// This means the surrounding form action (`saveStory`) needs zero
// changes — the FormData still arrives with category = "Drama" etc.
//
// Accessibility: outer wrapper is role=radiogroup; each chip is a
// button with aria-pressed.

import { useState } from "react";
import { CATEGORIES } from "@/app/admin/ui";

type Category = (typeof CATEGORIES)[number];

// Per-category tint, used to color the chip's dot + selected-state
// background. Mirrors the --color-cat-* tokens in globals.css; no
// dynamic Tailwind class generation (Tailwind purge would drop those)
// so each category gets explicit class strings.
const CATEGORY_DOT_CLASS: Record<Category, string> = {
  Drama: "bg-cat-drama",
  Entitled: "bg-cat-entitled",
  Humor: "bg-cat-humor",
  Wholesome: "bg-cat-wholesome",
  Dating: "bg-cat-dating",
  Roommate: "bg-cat-roommate",
};

const CATEGORY_SELECTED_CLASS: Record<Category, string> = {
  Drama: "border-cat-drama bg-cat-drama/15 text-ink",
  Entitled: "border-cat-entitled bg-cat-entitled/15 text-ink",
  Humor: "border-cat-humor bg-cat-humor/15 text-ink",
  Wholesome: "border-cat-wholesome bg-cat-wholesome/15 text-ink",
  Dating: "border-cat-dating bg-cat-dating/15 text-ink",
  Roommate: "border-cat-roommate bg-cat-roommate/15 text-ink",
};

export function CategoryChipGroup({
  name,
  initial,
}: {
  /** Name of the hidden input the surrounding form reads. */
  name: string;
  initial: string;
}) {
  const isKnown = (CATEGORIES as readonly string[]).includes(initial);
  const safeInitial: Category = isKnown ? (initial as Category) : "Entitled";
  const [value, setValue] = useState<Category>(safeInitial);

  return (
    <div data-testid="category-chip-group">
      <input type="hidden" name={name} value={value} />
      <div
        role="radiogroup"
        aria-label="Category"
        className="flex flex-wrap gap-1.5"
      >
        {CATEGORIES.map((cat) => {
          const selected = value === cat;
          return (
            <button
              key={cat}
              type="button"
              role="radio"
              aria-checked={selected}
              data-cat={cat}
              onClick={() => setValue(cat)}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
                selected
                  ? CATEGORY_SELECTED_CLASS[cat]
                  : "border-line bg-bg text-muted hover:border-ink hover:text-ink"
              }`}
            >
              <span
                aria-hidden
                className={`inline-block h-2 w-2 rounded-full ${CATEGORY_DOT_CLASS[cat]}`}
              />
              <span>{cat}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
