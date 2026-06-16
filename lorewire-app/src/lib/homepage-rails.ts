"use client";

// Shared homepage-rail resolution for DesktopShell + MobileShell. Phase 5
// of _plans/2026-06-16-homepage-curation.md: with the hardcoded TOP10 /
// ENTITLED_ROW / NEW_ROW / CONTINUE constants gone from stories.ts, both
// shells now resolve their rails through this single module:
//
//   1. fetch curation + behavior on mount (one round trip)
//   2. for each rail, prefer the curated ids; if empty,
//      "fallback" -> derived defaults from STORIES (auto by category /
//      most-recent / first-N), "hide" -> render nothing
//   3. unknown story ids (curated but not in the static catalog yet)
//      are filtered out at the tryById layer so a stale curation row
//      can't crash the rail.
//
// Pure helpers + a thin React hook — no JSX so both shells can compose
// the result into their own layouts. Server-only modules stay out of
// this file so it's client-safe.

import { useEffect, useState } from "react";
import {
  getHomepageCuration,
  type HomepageCuration,
  type HomepageCurationBehavior,
} from "@/app/actions";
import { STORIES, type Cat } from "@/lib/stories";

export const DEFAULT_CURATION_BEHAVIOR: HomepageCurationBehavior = {
  emptyRailBehavior: "fallback",
  heroRequired: false,
};

export interface CategoryRailSpec {
  surface: keyof HomepageCuration;
  title: string;
  cat: Cat | null;
}

// Single source of truth for which category rails the homepage knows
// about + the public title each renders. DesktopShell + MobileShell
// both iterate this so adding/renaming a row is a one-line change.
export const CATEGORY_RAILS: CategoryRailSpec[] = [
  { surface: "entitled_row", title: "Audacity: Entitled People", cat: "Entitled" },
  { surface: "humor_row", title: "Humor & Awkward Moments", cat: "Humor" },
  { surface: "wholesome_row", title: "Wholesome Wins", cat: "Wholesome" },
  { surface: "dating_row", title: "Dating Disasters", cat: "Dating" },
  { surface: "roommate_row", title: "Roommate Files", cat: "Roommate" },
  { surface: "drama_row", title: "Pure Drama", cat: "Drama" },
];

// Derived fallbacks for each surface. With the hardcoded rail constants
// gone from stories.ts, "fallback" no longer means "use that specific
// list of ids" — it means "auto-derive a sensible default from the
// current sample catalog." Same UX during rollout, no manual list to
// maintain.
export function fallbackIdsForSurface(
  surface: keyof HomepageCuration,
): string[] {
  switch (surface) {
    case "hero":
      // Single envelope hero matches the legacy default.
      return STORIES.length > 0 ? [STORIES[0].id] : [];
    case "top10":
      // First 10 catalog entries; admin curates the real ordering.
      return STORIES.slice(0, 10).map((s) => s.id);
    case "continue":
      // Editor-curated rail with no per-user state yet — pick the first
      // 4 as a visual placeholder so the rail looks alive during rollout.
      return STORIES.slice(0, 4).map((s) => s.id);
    case "new_row":
      // Sort by year DESC and slice 6; ties keep catalog order.
      return [...STORIES]
        .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
        .slice(0, 6)
        .map((s) => s.id);
    default: {
      const rail = CATEGORY_RAILS.find((r) => r.surface === surface);
      if (!rail || !rail.cat) return [];
      return STORIES.filter((s) => s.cat === rail.cat).slice(0, 6).map((s) => s.id);
    }
  }
}

// Fetch curation on mount + return a steady-state result both shells can
// render off. `loaded` flips true once the round trip lands so the
// caller can distinguish "still loading" from "loaded but empty"
// without exposing the underlying null sentinel.
export interface UseHomepageCurationResult {
  curation: HomepageCuration | null;
  behavior: HomepageCurationBehavior;
  loaded: boolean;
}

export function useHomepageCuration(): UseHomepageCurationResult {
  const [curation, setCuration] = useState<HomepageCuration | null>(null);
  const [behavior, setBehavior] = useState<HomepageCurationBehavior>(
    DEFAULT_CURATION_BEHAVIOR,
  );
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getHomepageCuration()
      .then((r) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console -- rule 14
        console.info("[lorewire curation load]", {
          raw_count: r.raw_curation_count,
          per_surface: Object.fromEntries(
            Object.entries(r.curation).map(([k, v]) => [k, v.length]),
          ),
          behavior: r.behavior,
        });
        setCuration(r.curation);
        setBehavior(r.behavior);
        setLoaded(true);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console -- rule 14
        console.warn("[lorewire curation load error]", { err: String(err) });
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { curation, behavior, loaded };
}

// Returns the id list to render for a surface, or `null` when the rail
// should be skipped entirely (empty curation + behavior.emptyRailBehavior
// === "hide"). Logs the decision per rule 14 so a stale fallback or
// hidden rail is greppable from the console.
export function resolveRailIds(
  surface: keyof HomepageCuration,
  curation: HomepageCuration | null,
  behavior: HomepageCurationBehavior,
): string[] | null {
  const curated = curation?.[surface] ?? [];
  if (curated.length > 0) return curated;
  if (curation && behavior.emptyRailBehavior === "hide") {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[lorewire curation hide]", { surface, reason: "empty" });
    return null;
  }
  const fallback = fallbackIdsForSurface(surface);
  if (curation) {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[lorewire curation fallback]", {
      surface,
      reason: "empty",
      fallback_count: fallback.length,
    });
  }
  return fallback;
}
