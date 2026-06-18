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

import { useEffect, useMemo, useState } from "react";
import {
  getHomepageCuration,
  getHomepagePolls,
  getLiveCatalog,
  type HomepageCuration,
  type HomepageCurationBehavior,
  type HomepagePollRailsResult,
  type LiveCatalogStory,
} from "@/app/actions";
import { CAT, STORIES, tryById, type Cat, type Story } from "@/lib/stories";
import { POLL_RAIL_KINDS, type PollRailKind } from "@/lib/polls-shared";

// Empty-state sentinel for the poll-rails hook. Lives here (client-
// safe module) instead of in actions.ts because Next.js 16's "use
// server" boundary refuses non-async exports — a plain object would
// be wrapped into a server-function reference and useState would
// fail with "Server Functions cannot be called during initial
// render." Sentinel needs to be a plain object on the client side
// to feed useState's initial value cleanly.
const HOMEPAGE_POLL_RAILS_EMPTY: HomepagePollRailsResult = {
  ok: false,
  rails: { divisive: [], agreed: [], unpopular: [] },
  enabled: { divisive: true, agreed: true, unpopular: true },
};

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
// MERGED catalog (live DB + sample STORIES)". Live entries win for the
// "most recent" ordering so newly published stories show up on the
// homepage without waiting for `python -m pipeline.export_app` to
// re-bake src/data/published.ts.
export function fallbackIdsForSurface(
  surface: keyof HomepageCuration,
  catalog: Story[],
): string[] {
  switch (surface) {
    case "hero":
      return catalog.length > 0 ? [catalog[0].id] : [];
    case "top10":
      return catalog.slice(0, 10).map((s) => s.id);
    case "continue":
      return catalog.slice(0, 4).map((s) => s.id);
    case "new_row":
      // Sort by year DESC and slice 6; ties keep merged-catalog order
      // (which is "live first, sample second" by construction).
      return [...catalog]
        .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
        .slice(0, 6)
        .map((s) => s.id);
    default: {
      const rail = CATEGORY_RAILS.find((r) => r.surface === surface);
      if (!rail || !rail.cat) return [];
      return catalog
        .filter((s) => s.cat === rail.cat)
        .slice(0, 6)
        .map((s) => s.id);
    }
  }
}

// Translate a live DB row into the Story shape the rail components render
// against. Derived fields (year from published_at, glyph from category,
// tags from the category alone) match the published.ts overlay so the
// visual contract stays identical regardless of source.
const GLYPH_BY_CAT: Record<Cat, string> = {
  Drama: "/",
  Entitled: "$",
  Humor: "!",
  Wholesome: "+",
  Dating: "?",
  Roommate: "#",
};

export function liveRowToStory(row: LiveCatalogStory): Story {
  const rawCat = (row.category ?? "Drama") as string;
  const cat: Cat = (Object.keys(CAT) as Cat[]).includes(rawCat as Cat)
    ? (rawCat as Cat)
    : "Drama";
  const ts = row.published_at ?? row.created_at ?? "";
  let year = 2026;
  try {
    const parsed = parseInt(String(ts).slice(0, 4), 10);
    if (Number.isFinite(parsed)) year = parsed;
  } catch {
    /* keep default */
  }
  const story: Story = {
    id: row.id,
    title: (row.title ?? row.id).toUpperCase(),
    cat,
    dur: row.duration ?? "2:00",
    match: 90,
    year,
    glyph: GLYPH_BY_CAT[cat],
    tags: ["True Story", cat],
    syn: row.summary ?? "",
  };
  if (row.hero_image) story.heroImage = row.hero_image;
  if (row.video_url) story.videoUrl = row.video_url;
  return story;
}

// Merge static STORIES with live DB rows. Live wins when an id collides
// so freshly-uploaded artwork / titles take precedence over the sample
// catalog's seed values. Returns an array (rail derivations iterate it
// in "live first" order) and a Map (component lookups are O(1)).
export interface MergedCatalog {
  array: Story[];
  byId: Map<string, Story>;
}

export function mergeStaticAndLive(live: LiveCatalogStory[]): MergedCatalog {
  const liveStories = live.map(liveRowToStory);
  const byId = new Map<string, Story>();
  // Live first so live ordering is the natural "most recent" order +
  // a collision keeps the live record.
  for (const s of liveStories) byId.set(s.id, s);
  for (const s of STORIES) {
    if (!byId.has(s.id)) byId.set(s.id, s);
  }
  const array = [
    ...liveStories,
    ...STORIES.filter((s) => !liveStories.some((l) => l.id === s.id)),
  ];
  return { array, byId };
}

// Fetch curation + live catalog on mount and return a steady-state result
// both shells can render off. `loaded` flips true once the round trips
// land so the caller can distinguish "still loading" from "loaded but
// empty" without exposing the underlying null sentinel.
//
// resolveStory(id) is the homepage's source of truth for card metadata:
// live DB row first, sample STORIES second, null when neither knows the
// id (filtered out at the rail layer so stale curation can't crash).
export interface UseHomepageCurationResult {
  curation: HomepageCuration | null;
  behavior: HomepageCurationBehavior;
  catalog: MergedCatalog;
  resolveStory: (id: string) => Story | null;
  loaded: boolean;
}

// Stable empty catalog used during the initial render (before the live
// fetch lands) so consumers don't paint with a stale closure.
const EMPTY_LIVE: LiveCatalogStory[] = [];

export function useHomepageCuration(): UseHomepageCurationResult {
  const [curation, setCuration] = useState<HomepageCuration | null>(null);
  const [behavior, setBehavior] = useState<HomepageCurationBehavior>(
    DEFAULT_CURATION_BEHAVIOR,
  );
  const [liveRows, setLiveRows] = useState<LiveCatalogStory[]>(EMPTY_LIVE);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    Promise.all([getHomepageCuration(), getLiveCatalog()])
      .then(([cur, live]) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console -- rule 14
        console.info("[lorewire curation load]", {
          raw_count: cur.raw_curation_count,
          per_surface: Object.fromEntries(
            Object.entries(cur.curation).map(([k, v]) => [k, v.length]),
          ),
          behavior: cur.behavior,
          live_count: live.stories.length,
        });
        setCuration(cur.curation);
        setBehavior(cur.behavior);
        setLiveRows(live.stories);
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
  // Recompute the merged catalog only when the live rows change so every
  // rail rendering off it shares one stable reference.
  const catalog = useMemo(() => mergeStaticAndLive(liveRows), [liveRows]);
  const resolveStory = useMemo(() => {
    return (id: string): Story | null => {
      return catalog.byId.get(id) ?? tryById(id) ?? null;
    };
  }, [catalog]);
  return { curation, behavior, catalog, resolveStory, loaded };
}

// Phase 4.5 of _plans/2026-06-17-engagement-polls.md. Fetches the
// three derived homepage rails (divisive / agreed / unpopular) on
// mount. Mirrors useHomepageCuration's shape — a single round trip
// resolved by getHomepagePolls, error path falls back to the empty-
// rails sentinel so a busted query can never blank the rest of the
// homepage. Re-exports POLL_RAIL_KINDS so callers iterate the same
// order the server response carries.

export { POLL_RAIL_KINDS };
export type { PollRailKind };

export interface UseHomepagePollsResult {
  rails: HomepagePollRailsResult["rails"];
  enabled: HomepagePollRailsResult["enabled"];
  loaded: boolean;
}

export function useHomepagePolls(): UseHomepagePollsResult {
  const [state, setState] = useState<HomepagePollRailsResult>(
    HOMEPAGE_POLL_RAILS_EMPTY,
  );
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getHomepagePolls()
      .then((r) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console -- rule 14
        console.info("[lorewire polls rails load]", {
          counts: {
            divisive: r.rails.divisive.length,
            agreed: r.rails.agreed.length,
            unpopular: r.rails.unpopular.length,
          },
          enabled: r.enabled,
        });
        setState(r);
        setLoaded(true);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console -- rule 14
        console.warn("[lorewire polls rails load error]", {
          err: String(err),
        });
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { rails: state.rails, enabled: state.enabled, loaded };
}

/** Stable display title per rail. Single source of truth so adding a
 *  new rail kind in the future surfaces compile errors at every call
 *  site. */
export const POLL_RAIL_TITLES: Record<PollRailKind, string> = {
  divisive: "Most divisive stories",
  agreed: "Community agreed",
  unpopular: "Unpopular opinions",
};

// Returns the id list to render for a surface, or `null` when the rail
// should be skipped entirely (empty curation + behavior.emptyRailBehavior
// === "hide"). Logs the decision per rule 14 so a stale fallback or
// hidden rail is greppable from the console.
export function resolveRailIds(
  surface: keyof HomepageCuration,
  curation: HomepageCuration | null,
  behavior: HomepageCurationBehavior,
  catalog: MergedCatalog,
): string[] | null {
  const curated = curation?.[surface] ?? [];
  if (curated.length > 0) return curated;
  if (curation && behavior.emptyRailBehavior === "hide") {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[lorewire curation hide]", { surface, reason: "empty" });
    return null;
  }
  const fallback = fallbackIdsForSurface(surface, catalog.array);
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
