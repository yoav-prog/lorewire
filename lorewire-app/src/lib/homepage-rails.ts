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
  STORIES,
  isPublishedStory,
  tryById,
  type Story,
} from "@/lib/stories";
import { GRANULAR_CATEGORIES } from "@/lib/categories/granular";
import { categoryGlyph } from "@/lib/categories/visuals";
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
  /** Category LABEL this rail filters by (matched against `Story.cat`), or
   *  null for non-category surfaces. A free string now that categories are
   *  data-driven (the 18-set), not the legacy 6-item union. */
  cat: string | null;
}

// Which category rails the homepage knows about + the public title each
// renders. DesktopShell + MobileShell both iterate this. The rail set,
// order, titles, and surfaces all trace back to the shared category
// manifest (CATEGORY_RAIL_ENTRIES) so a category change is one edit
// there; this file only maps the entries into the curation-typed shape.
export const CATEGORY_RAILS: CategoryRailSpec[] = GRANULAR_CATEGORIES.filter(
  (c) => c.isRail,
).map((c) => ({
  surface: c.slug as keyof HomepageCuration,
  title: c.railTitle ?? c.label,
  cat: c.label,
}));

// Rotating-category helpers (slice E of homepage redesign v1) moved to
// lib/homepage-curation-shared.ts so server-only loaders can import
// them without crossing the "use client" boundary at the top of this
// file. Re-exported below to keep this module's public surface stable
// for client callers that already import from "@/lib/homepage-rails".
export {
  isRotatingCategorySurface,
  pickRotatingCategoryByDay,
  resolveRotatingCategorySurface,
  ROTATING_CATEGORY_SURFACES,
  rotatingCategoryEnabledSettingKey,
  rotatingCategoryOverrideSettingKey,
  type RotatingCategorySurface,
} from "@/lib/homepage-curation-shared";

// Per-rail fallback cap. Keeps SSR payload bounded; the rails scroll
// horizontally so the cap is a payload control, not a visual one.
const FALLBACK_RAIL_CAP = 20;

// Hero is special — it's a rotation pool with a fixed visual contract
// (capacity 8 in SURFACE_CAPACITY, the carousel iterates the whole
// list). Cap the hero fallback at the same capacity so an admin-empty
// hero rail auto-rotates through 8 recent picks, matching the size
// curation would have set.
const HERO_FALLBACK_CAP = 8;

// Derived fallbacks for each surface. With the hardcoded rail constants
// gone from stories.ts, "fallback" no longer means "use that specific
// list of ids" — it means "auto-derive a sensible default from the
// MERGED catalog (live DB + sample STORIES)". Live entries win for the
// "most recent" ordering so newly published stories show up on the
// homepage without waiting for `python -m pipeline.export_app` to
// re-bake src/data/published.ts.
//
// CRITICAL: every fallback path filters by isPublishedStory BEFORE the
// slice. Slicing first then filtering was the 2026-06-24 bug that
// crashed every category rail to 0-2 items in production — the first
// N catalog entries by category often include sample placeholders or
// live rows whose hero artwork hasn't rendered yet, so the post-slice
// filter dropped most of the rail. Filtering first means the cap
// counts published stories, not candidates.
export function fallbackIdsForSurface(
  surface: keyof HomepageCuration,
  catalog: Story[],
): string[] {
  const published = catalog.filter(isPublishedStory);
  switch (surface) {
    case "hero":
      // Up to HERO_FALLBACK_CAP most-recent published stories so the
      // rotation carousel auto-fills without admin curation. Same sort
      // shape as new_row (year DESC, ties keep merged catalog order so
      // live entries beat sample placeholders). The earlier "first
      // published only" behavior left an uncurated hero stuck on a
      // single static slide — exactly the inverse of the rotation the
      // feature was built for.
      return [...published]
        .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
        .slice(0, HERO_FALLBACK_CAP)
        .map((s) => s.id);
    case "top10":
      return published.slice(0, 10).map((s) => s.id);
    case "continue":
      return published.slice(0, 4).map((s) => s.id);
    case "new_row":
      // Sort by year DESC; ties keep merged-catalog order (live first,
      // sample second) so the freshest published story leads the rail.
      return [...published]
        .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
        .slice(0, FALLBACK_RAIL_CAP)
        .map((s) => s.id);
    default: {
      const rail = CATEGORY_RAILS.find((r) => r.surface === surface);
      if (!rail || !rail.cat) return [];
      return published
        .filter((s) => s.cat === rail.cat)
        .slice(0, FALLBACK_RAIL_CAP)
        .map((s) => s.id);
    }
  }
}

// Translate a live DB row into the Story shape the rail components render
// against. Derived fields (year from published_at, glyph from category,
// tags from the category alone) match the published.ts overlay so the
// visual contract stays identical regardless of source.
export function liveRowToStory(row: LiveCatalogStory): Story {
  // Free-form category label from the DB (the 18-set). Color + glyph resolve
  // at runtime through the shared visual resolver; unknown values degrade to
  // a neutral swatch rather than falling back to a wrong category.
  const cat = row.category ?? "";
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
    // Empty string when unknown — display sites gate the badge on truthiness
    // so a missing duration shows nothing rather than the historical "2:00"
    // long-form default. loadLiveCatalog backfills from short_renders when
    // stories.duration is NULL, so this lands populated for finished shorts.
    dur: row.duration ?? "",
    match: 90,
    year,
    glyph: categoryGlyph(cat),
    tags: ["True Story", cat],
    syn: row.summary ?? "",
  };
  if (row.hero_image) story.heroImage = row.hero_image;
  if (row.video_url) story.videoUrl = row.video_url;
  // 2026-06-25 stories-reader-navigation plan: propagate slug so the
  // Stories viewer's "Read full →" CTA can navigate to /v/[slug]
  // without a per-active-wire getLiveStoryMedia fetch. Consumers that
  // don't have a slug (sample placeholders, unpublished rows) still
  // satisfy the type because Story.slug is optional.
  if (row.slug) story.slug = row.slug;
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
    // Live slug wins for the same reason title / heroImage do — the DB
    // is the source of truth for the public reader path. Static seed
    // stories don't have a slug, but the ?? pattern means a future
    // static slug would still fill in for a live row that lacks one.
    slug: liveStory.slug ?? staticStory.slug,
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
 *  site.
 *
 *  `unpopular` is the personalized "You Voted With the Minority" rail
 *  post-slice-A of _plans/2026-06-26-homepage-redesign-v1.md — the
 *  rail only surfaces to viewers who've voted on the losing side
 *  enough times to meet the threshold, so the title can name the
 *  identity directly. The dedicated /c/unpopular landing page keeps
 *  the "Unpopular opinions" framing because that page falls back to
 *  landslide stories for anonymous viewers (a different surface, a
 *  different contract). */
export const POLL_RAIL_TITLES: Record<PollRailKind, string> = {
  divisive: "The Internet Can't Agree",
  agreed: "Community agreed",
  unpopular: "You Voted With the Minority",
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

// Surfaces that AUGMENT (curated ids pin at the front, fallback fills the
// rest). The 2026-06-24 user feedback was: "curating 2 Dramas should mean
// those 2 lead the rail, not that the entire rail is exactly those 2."
// Augmenting matches that intuition AND makes thin curations self-heal —
// a forgotten 2-pick curation from months ago no longer silently shrinks
// the rail to 2. Hero joined this set when the rotation carousel landed
// (capacity 8): an uncurated hero now auto-fills with the most recent
// published stories, and curated picks pin at the front so editorial
// can feature specific stories without losing the rotation.
//
// `continue` keeps its own resolution chain (curation → user override →
// fallback, no mixing) because the rail's promise is "your progress,"
// not "editorial picks mixed with your progress."
const AUGMENTING_SURFACES = new Set<keyof HomepageCuration>([
  "hero",
  "top10",
  "new_row",
  ...CATEGORY_RAILS.map((r) => r.surface),
]);

export function resolveRailIds(
  surface: keyof HomepageCuration,
  curation: HomepageCuration | null,
  behavior: HomepageCurationBehavior,
  catalog: MergedCatalog,
  userOverrides?: RailUserOverrides,
): string[] | null {
  const curated = curation?.[surface] ?? [];

  // Continue Watching: personalized chain — curation OR user override OR
  // fallback, never mixed. Editorial picks shouldn't blend into a user's
  // own progress list; the user's localStorage state IS the rail's truth.
  if (surface === "continue") {
    if (curated.length > 0) return curated;
    if (userOverrides?.continue && userOverrides.continue.length > 0) {
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
    return fallbackIdsForSurface(surface, catalog.array);
  }

  // Discovery rails — including hero now that it rotates — augment:
  // curated ids pin at the front, fallback fills the rest. Empty + hide
  // still wins so the admin's explicit "no fallback for this rail"
  // setting is honored.
  if (
    AUGMENTING_SURFACES.has(surface) &&
    curated.length === 0 &&
    curation &&
    behavior.emptyRailBehavior === "hide"
  ) {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[lorewire curation hide]", { surface, reason: "empty" });
    return null;
  }
  const fallback = fallbackIdsForSurface(surface, catalog.array);
  const curatedSet = new Set(curated);
  const augmented = [
    ...curated,
    ...fallback.filter((id) => !curatedSet.has(id)),
  ];
  if (curation && curated.length > 0) {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[lorewire curation augment]", {
      surface,
      curated: curated.length,
      fallback_added: augmented.length - curated.length,
      total: augmented.length,
    });
  } else if (curation) {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[lorewire curation fallback]", {
      surface,
      reason: "empty",
      fallback_count: fallback.length,
    });
  }
  return augmented;
}

/** Resolve the full rotation pool for the homepage hero carousel. The pool
 *  is admin-curated (curated picks pin at the front) and auto-fills with
 *  the most-divisive published stories from the catalog so an uncurated
 *  homepage opens on the verdict the audience can't agree on — the
 *  hook the carousel is meant to deliver. Capped at HERO_FALLBACK_CAP
 *  so the augmented set never exceeds the visual contract.
 *
 *  Resolution order (matches the v1 spec — slice D of
 *  _plans/2026-06-26-homepage-redesign-v1.md):
 *
 *    1. Curated hero picks pin at the front (admin override stays
 *       authoritative).
 *    2. `divisiveIds` (top-divisive story ids by current poll_aggregates
 *       data, server-resolved through the SSR seed) fill remaining slots.
 *    3. Recency fallback (most-recent published) fills any leftover slots,
 *       so a cold catalog with no divisive candidates yet still rotates
 *       instead of freezing on a single slide.
 *
 *  `divisiveIds` defaults to `[]` so legacy callers (no SSR seed wiring
 *  yet) preserve the pre-slice-D behaviour exactly: curated + recency,
 *  no divisive layer in the middle.
 *
 *  Returns [] when no published candidate exists (HomePage uses that as
 *  the signal to render the no-hero top-padded layout). */
export function resolveHeroPool(
  curation: HomepageCuration | null,
  behavior: HomepageCurationBehavior,
  catalog: MergedCatalog,
  resolveStory: (id: string) => Story | null,
  divisiveIds: string[] = [],
): Story[] {
  // heroRequired === true means admin set "no fallback for this rail":
  // ONLY curated picks count, even if it leaves the hero empty. Honour
  // it unchanged; slice D doesn't override that intent.
  if (behavior.heroRequired) {
    return collectPublishedStories(
      curation?.hero ?? [],
      resolveStory,
      HERO_FALLBACK_CAP,
    );
  }

  // Hide-when-empty: admin chose "hide" instead of fallback AND has
  // an explicit (possibly empty) curation. Returns [] so the carousel
  // doesn't render. Mirrors the resolveRailIds behaviour the previous
  // implementation routed through for hero.
  const curated = curation?.hero ?? [];
  if (
    curated.length === 0 &&
    curation &&
    behavior.emptyRailBehavior === "hide"
  ) {
    return [];
  }

  // Compose in priority order, deduplicating so a curated story that's
  // also top-divisive doesn't take two slots. Cap at the visual
  // contract.
  const recencyIds = fallbackIdsForSurface("hero", catalog.array);
  const seen = new Set<string>();
  const composed: string[] = [];
  for (const id of [...curated, ...divisiveIds, ...recencyIds]) {
    if (composed.length >= HERO_FALLBACK_CAP) break;
    if (seen.has(id)) continue;
    seen.add(id);
    composed.push(id);
  }
  return collectPublishedStories(composed, resolveStory, HERO_FALLBACK_CAP);
}

/** Walk an id list, resolve each id through the catalog, filter to
 *  published stories, cap the result. Shared seam between the
 *  heroRequired and augmenting paths above. */
function collectPublishedStories(
  ids: string[],
  resolveStory: (id: string) => Story | null,
  cap: number,
): Story[] {
  const pool: Story[] = [];
  for (const id of ids) {
    if (pool.length >= cap) break;
    const candidate = resolveStory(id);
    if (candidate && isPublishedStory(candidate)) pool.push(candidate);
  }
  return pool;
}

/** Convenience for callers that need a single hero (the legacy single-pick
 *  contract). Used by the outer shell's "Play Something" shuffle to know
 *  which story is currently visible in the marquee so a shuffle click
 *  doesn't replay it. `activeIndex` clamps into range so an out-of-band
 *  value is safe. */
export function pickHeroAtIndex(pool: Story[], activeIndex: number): Story | null {
  if (pool.length === 0) return null;
  const idx = Math.max(0, Math.min(activeIndex, pool.length - 1));
  return pool[idx];
}

/** @deprecated Use resolveHeroPool + pickHeroAtIndex(pool, 0). Kept as a
 *  thin wrapper so existing callers compile during the transition; will
 *  be removed once every call site is migrated. */
export function resolveHeroStory(
  curation: HomepageCuration | null,
  behavior: HomepageCurationBehavior,
  catalog: MergedCatalog,
  resolveStory: (id: string) => Story | null,
): Story | null {
  return pickHeroAtIndex(
    resolveHeroPool(curation, behavior, catalog, resolveStory),
    0,
  );
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

/** Drop ids the viewer has already voted on. Used to convert the raw
 *  Continue Watching list (engagement-store says "watched this story")
 *  into the "You Didn't Vote Yet" rail surface (watched but the viewer
 *  hasn't cast a verdict yet). Empty votedSet collapses to a no-op so
 *  anonymous viewers — who have no vote history — still see their raw
 *  watched list and the rail header stays honest (someone with zero
 *  votes hasn't voted on ANY of these).
 *
 *  Plan: _plans/2026-06-26-homepage-redesign-v1.md (slice C). Sibling
 *  of `filterIdsByPillCat` / `filterIdsByPublished`; the homepage
 *  shells compose them in order.
 */
export function filterIdsByNotVoted(
  ids: string[] | null | undefined,
  votedStoryIds: ReadonlySet<string>,
): string[] {
  if (!ids || ids.length === 0) return [];
  if (votedStoryIds.size === 0) return [...ids];
  return ids.filter((id) => !votedStoryIds.has(id));
}
