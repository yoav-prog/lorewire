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
  getPollForStoryView,
  type HomepageCuration,
  type HomepageCurationBehavior,
  type HomepagePollRailsResult,
  type LiveCatalogStory,
  type StoryPollSeed,
  type StoryPollView,
} from "@/app/actions";
import {
  CAT,
  STORIES,
  isPublishedStory,
  tryById,
  type Cat,
  type Story,
} from "@/lib/stories";
import { POLL_RAIL_KINDS, type PollRailKind } from "@/lib/polls-shared";

/** 2026-06-18 polls plan extension: client-side fetch hook for the
 *  per-story poll view the homepage DetailModal needs. Mirrors the
 *  useHomepagePolls pattern — single round trip on mount, error path
 *  returns null so the modal renders without a poll instead of
 *  crashing. The storyId arg drives the dep array so the hook
 *  re-fetches when the modal swaps to a different story.
 *
 *  The optional `story` arg supplies title/body/category so the server
 *  can lazy-autodraft a poll on first open if none exists yet —
 *  honors the "every story has a poll by default" invariant for
 *  stories published before the autodraft hooks landed. */
export function useStoryPoll(
  storyId: string | null | undefined,
  story?: Pick<Story, "title" | "syn" | "body" | "cat"> | null,
): {
  view: StoryPollView | null;
  loaded: boolean;
} {
  const [view, setView] = useState<StoryPollView | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Build the seed once per story so the dep array stays primitive.
  const seedTitle = story?.title ?? "";
  const seedBody = (story?.body ?? story?.syn ?? "") as string;
  const seedCategory = (story?.cat ?? "") as string;
  useEffect(() => {
    let cancelled = false;
    if (!storyId) {
      setView(null);
      setLoaded(true);
      return;
    }
    setLoaded(false);
    const seed: StoryPollSeed | undefined =
      seedTitle || seedBody || seedCategory
        ? { title: seedTitle, body: seedBody, category: seedCategory }
        : undefined;
    getPollForStoryView(storyId, seed)
      .then((r) => {
        if (cancelled) return;
        setView(r.view);
        setLoaded(true);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console -- rule 14
        console.warn("[useStoryPoll fetch failed]", {
          story_id: storyId,
          err: String(err),
        });
        if (!cancelled) {
          setView(null);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [storyId, seedTitle, seedBody, seedCategory]);
  return { view, loaded };
}

// Re-exported here (client-safe module) so client components don't need
// an explicit path to the server-only @/lib/homepage-data module. The
// type is erased at compile time so there's never a runtime crossing.
export type { HomepageInitial } from "@/lib/homepage-data";

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
  // On collision: MERGE field-by-field instead of replacing. The live
  // projection (LiveCatalogStory) doesn't carry body / images / audioUrl /
  // alignment / source_url — those live only in the PUBLISHED overlay
  // that has already been folded into STORIES at module load. Without this
  // merge, a story present in BOTH the DB and PUBLISHED loses its body
  // because the live entry overwrites the static one, and the Read tab
  // falls into the hardcoded envelope sample. Live wins where it has a
  // value (so freshly-uploaded hero artwork / titles take precedence);
  // static fills in everything the live projection can't carry.
  const staticById = new Map<string, Story>(STORIES.map((s) => [s.id, s]));
  for (const liveStory of liveStories) {
    const staticVersion = staticById.get(liveStory.id);
    byId.set(liveStory.id, staticVersion ? mergeLiveOverStatic(staticVersion, liveStory) : liveStory);
  }
  for (const s of STORIES) {
    if (!byId.has(s.id)) byId.set(s.id, s);
  }
  // The array preserves live order (most recent first) and appends any
  // static-only entries that weren't in the live feed.
  const mergedLiveOrder = liveStories.map((s) => byId.get(s.id)!);
  const array = [
    ...mergedLiveOrder,
    ...STORIES.filter((s) => !liveStories.some((l) => l.id === s.id)),
  ];
  return { array, byId };
}

// Live wins for fields the LiveCatalogStory projection carries; static
// supplies everything else (body, images, audio, alignment, source_url —
// none of which the homepage rails fetch live to keep the catalog payload
// small).
function mergeLiveOverStatic(staticStory: Story, liveStory: Story): Story {
  return {
    ...staticStory,
    id: liveStory.id,
    title: liveStory.title || staticStory.title,
    cat: liveStory.cat,
    dur: liveStory.dur || staticStory.dur,
    year: liveStory.year || staticStory.year,
    glyph: liveStory.glyph || staticStory.glyph,
    syn: liveStory.syn || staticStory.syn,
    heroImage: liveStory.heroImage ?? staticStory.heroImage,
    heroImageLandscape: liveStory.heroImageLandscape ?? staticStory.heroImageLandscape,
    heroHasBakedTitle:
      liveStory.heroHasBakedTitle ?? staticStory.heroHasBakedTitle,
    videoUrl: liveStory.videoUrl ?? staticStory.videoUrl,
  };
}

// Fetch curation + live catalog on mount and return a steady-state result
// both shells can render off. `loaded` flips true once the round trips
// land so the caller can distinguish "still loading" from "loaded but
// empty" without exposing the underlying null sentinel.
//
// resolveStory(id) is the homepage's source of truth for card metadata:
// live DB row first, sample STORIES second, null when neither knows the
// id (filtered out at the rail layer so stale curation can't crash).
//
// When `initial` is provided, the hook initializes state from it and
// skips the useEffect fetch entirely — that path is taken when the
// homepage Server Component (src/app/page.tsx) pre-fetched the data
// and seeded the shells with it. `loaded` starts `true` because the
// data is already known. Without a seed, the hook keeps its legacy
// "fetch on mount" behavior so any caller that hasn't been migrated
// (or a future caller without an SSR path) still works.
// Plan: _plans/2026-06-18-homepage-no-flash-ssr.md.
export interface UseHomepageCurationInitial {
  curation: HomepageCuration | null;
  behavior: HomepageCurationBehavior;
  liveRows: LiveCatalogStory[];
}

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

export function useHomepageCuration(
  initial?: UseHomepageCurationInitial,
): UseHomepageCurationResult {
  const [curation, setCuration] = useState<HomepageCuration | null>(
    initial?.curation ?? null,
  );
  const [behavior, setBehavior] = useState<HomepageCurationBehavior>(
    initial?.behavior ?? DEFAULT_CURATION_BEHAVIOR,
  );
  const [liveRows, setLiveRows] = useState<LiveCatalogStory[]>(
    initial?.liveRows ?? EMPTY_LIVE,
  );
  const [loaded, setLoaded] = useState(initial !== undefined);
  // Seeded path: SSR already resolved the data, no client fetch needed.
  // The empty dep list keeps this effect from re-running on prop changes
  // — the seed is locked in at first mount, which is what we want for
  // a stable steady-state homepage. A future hot-reload-on-navigate
  // refinement would re-seed; today's pages don't need it.
  const seeded = initial !== undefined;
  useEffect(() => {
    if (seeded) return;
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
  }, [seeded]);
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

// `initial` mirrors useHomepageCuration: when the homepage Server
// Component pre-fetched the polls payload, the hook initializes state
// from it and skips the client fetch. See useHomepageCuration for the
// rationale and the legacy-path contract.
export function useHomepagePolls(
  initial?: HomepagePollRailsResult,
): UseHomepagePollsResult {
  const [state, setState] = useState<HomepagePollRailsResult>(
    initial ?? HOMEPAGE_POLL_RAILS_EMPTY,
  );
  const [loaded, setLoaded] = useState(initial !== undefined);
  const seeded = initial !== undefined;
  useEffect(() => {
    if (seeded) return;
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
  }, [seeded]);
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
//
// 2026-06-19 Phase 2 anonymous-first auth: `userOverrides` carries the
// browser's per-user state (Continue Watching ids from
// lib/engagement-store useContinueReading). Resolution order for the
// `continue` surface specifically:
//   1. Admin curation (if any) — admin override beats everything.
//   2. User's continue_reading list — the real progress this browser
//      has, sorted most-recent first.
//   3. Static catalog fallback — first-N stories, the legacy behavior.
// For every other surface, userOverrides is ignored. Keeps the rail
// resolver pure (no React, no consent gate — the caller has already
// honored consent before reading from engagement-store).
export interface RailUserOverrides {
  /** Story ids the user has in-progress on this device, most-recent first.
   *  Read from useContinueReading().ids in the calling shell. */
  continue?: string[];
}

export function resolveRailIds(
  surface: keyof HomepageCuration,
  curation: HomepageCuration | null,
  behavior: HomepageCurationBehavior,
  catalog: MergedCatalog,
  userOverrides?: RailUserOverrides,
): string[] | null {
  const curated = curation?.[surface] ?? [];
  if (curated.length > 0) return curated;
  if (
    surface === "continue" &&
    userOverrides?.continue &&
    userOverrides.continue.length > 0
  ) {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[lorewire curation user-continue]", {
      surface,
      count: userOverrides.continue.length,
    });
    return userOverrides.continue;
  }
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

// The "All" sentinel for the homepage pill row. Lives next to
// CATEGORY_RAILS / PILLS so the filter helper and the chip renderer
// reference the same literal instead of two copies that can drift.
export const ALL_PILL = "All";

/** Drop ids whose resolved story doesn't match the active pill category.
 *  Pure helper used by both shells so the filter behaves identically on
 *  mobile + desktop and so we can unit-test it without mounting JSX.
 *
 *  - `pill === ALL_PILL` returns the list unchanged.
 *  - Ids that don't resolve (stale curation pointing at a deleted story)
 *    are dropped — they would have been dropped at the rail layer anyway.
 *  - The check uses `story.cat`, which liveRowToStory + the published.ts
 *    overlay both populate from `stories.category`. So updating a story's
 *    category in the DB and refreshing is enough for the pill filter to
 *    pick it up; no rebake of published.ts required.
 */
export function filterIdsByPillCat(
  ids: string[] | null | undefined,
  pill: string,
  resolveStory: (id: string) => Story | null,
): string[] {
  if (!ids || ids.length === 0) return [];
  if (pill === ALL_PILL) return ids;
  return ids.filter((id) => {
    const s = resolveStory(id);
    return s ? s.cat === pill : false;
  });
}

/** Drop ids whose resolved story has no produced content (sample
 *  placeholder). Same `isPublishedStory` gate Browse / Search / New & Hot
 *  use; the home page rails apply it last so curated and fallback paths
 *  both flow through it. Stale curation pointing at a deleted story is
 *  dropped too (consistent with `filterIdsByPillCat`).
 */
export function filterIdsByPublished(
  ids: string[] | null | undefined,
  resolveStory: (id: string) => Story | null,
): string[] {
  if (!ids || ids.length === 0) return [];
  return ids.filter((id) => {
    const s = resolveStory(id);
    return s ? isPublishedStory(s) : false;
  });
}
