"use client";

// Multi-select category filter chips for Browse (desktop) and Search
// (mobile). The selected categories live in the URL as `?cat=Drama,Humor`
// so filtered views are shareable, refresh-safe, and the browser back
// button returns the user to "All". Multiple chips OR together.
//
// The hook + component are intentionally split: `useCategoryFilter` is
// the URL-backed state machine (used to filter the data), and
// `CategoryFilterChips` is the presentational row. Callers wire the two
// together so the filter logic stays out of the shells' render code.

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { categoryVisual } from "@/lib/categories/visuals";
import { GRANULAR_CATEGORIES } from "@/lib/categories/granular";

const QUERY_KEY = "cat";

// Stable order for the chip row — the 18 category labels, in seed order.
export const CATEGORY_ORDER: readonly string[] = GRANULAR_CATEGORIES.map(
  (c) => c.label,
);

function parseSelected(value: string | null): Set<string> {
  if (!value) return new Set();
  const raw = value.split(",").map((s) => s.trim()).filter(Boolean);
  const valid = raw.filter((s) => (CATEGORY_ORDER as string[]).includes(s));
  return new Set(valid);
}

function serializeSelected(selected: Set<string>): string {
  // Preserve CATEGORY_ORDER so the URL is stable regardless of click
  // order. `Drama,Humor` and `Humor,Drama` would otherwise produce two
  // different URLs for the same filter, which breaks shareable links.
  return CATEGORY_ORDER.filter((c) => selected.has(c)).join(",");
}

export interface CategoryFilterState {
  selected: Set<string>;
  toggle: (cat: string) => void;
  clear: () => void;
}

// Reads the active category filter from the URL and returns helpers
// that update the URL via router.replace (no history pollution).
// Components consume `selected` to filter their data and pass `toggle`
// + `clear` to <CategoryFilterChips />.
export function useCategoryFilter(): CategoryFilterState {
  const router = useRouter();
  const params = useSearchParams();
  const raw = params?.get(QUERY_KEY) ?? null;

  const selected = useMemo(() => parseSelected(raw), [raw]);

  const writeSelected = useCallback(
    (next: Set<string>) => {
      const sp = new URLSearchParams(params?.toString() ?? "");
      const value = serializeSelected(next);
      if (value) {
        sp.set(QUERY_KEY, value);
      } else {
        sp.delete(QUERY_KEY);
      }
      const qs = sp.toString();
      const href = qs ? `?${qs}` : window.location.pathname;
      // replace keeps the back button pointed at the page the user
      // arrived from, not at every chip tap they made along the way.
      router.replace(href, { scroll: false });
      // eslint-disable-next-line no-console -- rule 14
      console.info("[browse category filter]", {
        action: "write",
        selected: Array.from(next),
        href,
      });
    },
    [params, router],
  );

  const toggle = useCallback(
    (cat: string) => {
      const next = new Set(selected);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      writeSelected(next);
    },
    [selected, writeSelected],
  );

  const clear = useCallback(() => {
    writeSelected(new Set());
  }, [writeSelected]);

  return { selected, toggle, clear };
}

export interface CategoryFilterChipsProps {
  selected: Set<string>;
  onToggle: (cat: string) => void;
  onClear: () => void;
  /** Visual density. `desktop` uses larger pills and tracking; `mobile`
   *  drops to a tighter row that wraps cleanly inside a 360px viewport. */
  variant?: "desktop" | "mobile";
}

// Presentational chip row. The "All" chip is active when nothing is
// selected and clears the filter when tapped while any chip is on —
// gives a lazy user a single obvious "reset" affordance without a
// separate clear-link to discover.
export function CategoryFilterChips({
  selected,
  onToggle,
  onClear,
  variant = "desktop",
}: CategoryFilterChipsProps) {
  const allActive = selected.size === 0;
  const isDesktop = variant === "desktop";
  const sizing = isDesktop
    ? "px-3.5 py-1.5 text-[11px] tracking-[.18em]"
    : "px-3 py-1 text-[10px] tracking-[.16em]";

  return (
    <div
      role="group"
      aria-label="Filter by category"
      className={`flex flex-wrap gap-2 ${isDesktop ? "mt-5" : "mt-3"}`}
    >
      <CategoryChip
        key="__all"
        label="All"
        active={allActive}
        onClick={allActive ? () => {} : onClear}
        sizing={sizing}
        tone={undefined}
      />
      {CATEGORY_ORDER.map((cat) => {
        const active = selected.has(cat);
        return (
          <CategoryChip
            key={cat}
            label={cat}
            active={active}
            onClick={() => onToggle(cat)}
            sizing={sizing}
            tone={categoryVisual(cat).color}
          />
        );
      })}
    </div>
  );
}

function CategoryChip({
  label,
  active,
  onClick,
  sizing,
  tone,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  sizing: string;
  tone: string | undefined;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      data-active={active}
      data-category={label}
      className={`shrink-0 rounded-full border font-mono uppercase transition-colors ${sizing} ${
        active
          ? "border-transparent text-bg"
          : "border-line text-muted hover:text-ink hover:border-ink"
      }`}
      style={
        active
          ? { background: tone ?? "#F5F3EF", color: tone ? "#fff" : "#0A0A0C" }
          : undefined
      }
    >
      {label}
    </button>
  );
}

// Filter a list of stories by the active selection. An empty selection
// returns the input untouched so callers can pipe through unconditionally.
export function filterStoriesByCategory<T extends { cat: string }>(
  items: T[],
  selected: Set<string>,
): T[] {
  if (selected.size === 0) return items;
  return items.filter((s) => selected.has(s.cat));
}
