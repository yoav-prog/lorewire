// Local, honest engagement for the Wires feed + My List. No consumer accounts
// exist, so "liked" and "saved" live in THIS browser only (localStorage) — we
// never show fabricated social counts. Saved stories ARE the My List: one
// external store is shared by the feed's Save button, the My List tab, and the
// Title sheet so every surface stays in sync and survives a refresh.
//
// When real accounts land, swap the localStorage read/write inside the store
// for a server call; the component API (useSavedStories / useLikedWires) does
// not change. That's the "pre-instrument now" path from the plan.
//
// 2026-06-19 cookie consent gate: toggles only persist when consent has
// been explicitly accepted (lw_consent cookie === "accepted"). With
// consent rejected OR undecided, the in-memory set still updates so the
// UI reflects the click optimistically, but the localStorage write is
// skipped — a refresh wipes anything tried in that window. The banner's
// grandfather branch silently accepts for existing users, so this gate
// is invisible to anyone with prior persisted state.
// Plan: _plans/2026-06-19-anonymous-first-auth.md.

import { useSyncExternalStore } from "react";

type Listener = () => void;

/** True when the lw_consent cookie says "accepted". Read every toggle
 *  (cheap — document.cookie is a string parse) so flipping consent in a
 *  side panel takes effect on the next interaction without prop drilling
 *  or store coupling. */
function consentAccepted(): boolean {
  if (typeof document === "undefined") return false;
  const cookies = document.cookie.split("; ");
  for (const pair of cookies) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== "lw_consent") continue;
    return decodeURIComponent(pair.slice(eq + 1)) === "accepted";
  }
  return false;
}

// Stable empty reference for the server/first-paint snapshot so
// useSyncExternalStore never loops.
const EMPTY: string[] = [];

interface IdSetStore {
  subscribe: (cb: Listener) => () => void;
  getSnapshot: () => string[];
  getServerSnapshot: () => string[];
  toggle: (id: string) => void;
  has: (id: string) => boolean;
}

function createIdSetStore(storageKey: string): IdSetStore {
  let ids = new Set<string>();
  // Cached array so getSnapshot returns a stable reference between changes.
  let snapshot: string[] = EMPTY;
  const listeners = new Set<Listener>();
  let started = false;

  const readStorage = (): Set<string> => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(
        Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [],
      );
    } catch {
      return new Set();
    }
  };

  const refreshSnapshot = () => {
    snapshot = Array.from(ids);
  };

  const notify = () => listeners.forEach((l) => l());

  // Hydrate from localStorage on first subscribe and keep in sync across tabs.
  const start = () => {
    if (started || typeof window === "undefined") return;
    started = true;
    ids = readStorage();
    refreshSnapshot();
    window.addEventListener("storage", (e) => {
      if (e.key !== storageKey) return;
      ids = readStorage();
      refreshSnapshot();
      notify();
    });
  };

  return {
    subscribe(cb) {
      start();
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot() {
      return snapshot;
    },
    getServerSnapshot() {
      return EMPTY;
    },
    toggle(id) {
      start();
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      // Skip the persistent write when consent has not been accepted.
      // The in-memory toggle still runs so the UI reflects the click
      // immediately; a refresh wipes it. Plan: cookie consent gate.
      if (consentAccepted()) {
        try {
          window.localStorage.setItem(
            storageKey,
            JSON.stringify(Array.from(ids)),
          );
        } catch {
          /* private mode / quota — keep the in-memory toggle so the UI still flips */
        }
      } else {
        console.info("[auth ui engagement-store consent-gated]", {
          storageKey,
          op: ids.has(id) ? "add" : "remove",
        });
      }
      refreshSnapshot();
      notify();
    },
    has(id) {
      return ids.has(id);
    },
  };
}

const savedStore = createIdSetStore("lw.saved.v1");
const likedStore = createIdSetStore("lw.liked.v1");
// 2026-06-19 Phase 2: favorite categories ride on the same id-set store
// shape — the category strings are a closed enum from @/app/admin/ui
// (Drama, Entitled, Humor, Wholesome, Dating, Roommate), so the same
// "set of strings, toggle, persist" primitive applies.
const favCategoryStore = createIdSetStore("lw.fav_categories.v1");

function useIdSet(store: IdSetStore): string[] {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

/** My List — the persisted set of saved story ids, shared across the shell. */
export function useSavedStories() {
  const saved = useIdSet(savedStore);
  return {
    saved,
    isSaved: (id: string) => saved.includes(id),
    toggle: savedStore.toggle,
  };
}

/** Liked wires — a local heart, no fabricated count. */
export function useLikedWires() {
  const liked = useIdSet(likedStore);
  return {
    liked,
    isLiked: (id: string) => liked.includes(id),
    toggle: likedStore.toggle,
  };
}

/** Favorite categories — the persisted set of category strings the user
 *  has marked as a favorite. The expected values are the six closed-enum
 *  strings in @/app/admin/ui CATEGORIES, but we don't validate at this
 *  layer — the toggle takes whatever string it's given. UI surfaces (the
 *  future favorite-categories picker) gate inputs to the enum. */
export function useFavoriteCategories() {
  const favorites = useIdSet(favCategoryStore);
  return {
    favorites,
    isFavorite: (category: string) => favorites.includes(category),
    toggle: favCategoryStore.toggle,
  };
}

/* ----------------------------- Ratings store ----------------------------- */
//
// Personal 1-5 star ratings, keyed by story id. Local + honest, exactly like
// likes/saves: this is the visitor's OWN verdict, shown back to them as a badge
// on rated thumbnails — never averaged into a fabricated community score on a
// zero-traffic catalog (per the LLM-council verdict, _plans/2026-06-22-
// ratings-and-share.md). Consent-gated like the other stores; a future server
// sync swaps the read/write here without changing useStoryRatings.

const EMPTY_RATINGS: Record<string, number> = {};

interface RatingStore {
  subscribe: (cb: Listener) => () => void;
  getSnapshot: () => Record<string, number>;
  getServerSnapshot: () => Record<string, number>;
  set: (id: string, stars: number) => void;
  remove: (id: string) => void;
}

/** Coerce an arbitrary value to a whole 1-5 star rating, or null if invalid. */
function clampStars(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= 1 && r <= 5 ? r : null;
}

function createRatingStore(storageKey: string): RatingStore {
  let ratings: Record<string, number> = {};
  // Cached snapshot so getSnapshot returns a stable reference between changes.
  let snapshot: Record<string, number> = EMPTY_RATINGS;
  const listeners = new Set<Listener>();
  let started = false;

  const readStorage = (): Record<string, number> => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      const out: Record<string, number> = {};
      for (const [id, val] of Object.entries(parsed)) {
        const stars = clampStars(val);
        if (id && stars !== null) out[id] = stars;
      }
      return out;
    } catch {
      return {};
    }
  };

  const refreshSnapshot = () => {
    snapshot = { ...ratings };
  };

  const notify = () => listeners.forEach((l) => l());

  const persist = () => {
    if (!consentAccepted()) {
      console.info("[auth ui engagement-store consent-gated]", {
        storageKey,
        op: "persist",
      });
      return;
    }
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(ratings));
    } catch {
      /* private mode / quota — in-memory state still updates */
    }
  };

  const start = () => {
    if (started || typeof window === "undefined") return;
    started = true;
    ratings = readStorage();
    refreshSnapshot();
    window.addEventListener("storage", (e) => {
      if (e.key !== storageKey) return;
      ratings = readStorage();
      refreshSnapshot();
      notify();
    });
  };

  return {
    subscribe(cb) {
      start();
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot() {
      return snapshot;
    },
    getServerSnapshot() {
      return EMPTY_RATINGS;
    },
    set(id, stars) {
      start();
      const clamped = clampStars(stars);
      if (!id || clamped === null) return;
      if (ratings[id] === clamped) return;
      ratings = { ...ratings, [id]: clamped };
      persist();
      refreshSnapshot();
      notify();
    },
    remove(id) {
      start();
      if (!(id in ratings)) return;
      const next = { ...ratings };
      delete next[id];
      ratings = next;
      persist();
      refreshSnapshot();
      notify();
    },
  };
}

const ratingStore = createRatingStore("lw.ratings.v1");

/** Personal star ratings (story id -> 1-5). Local + consent-gated, mirroring
 *  useSavedStories / useLikedWires. `setRating` clamps to 1-5; `clearRating`
 *  removes the rating entirely. */
export function useStoryRatings() {
  const ratings = useSyncExternalStore(
    ratingStore.subscribe,
    ratingStore.getSnapshot,
    ratingStore.getServerSnapshot,
  );
  return {
    ratings,
    getRating: (id: string): number | undefined => ratings[id],
    setRating: ratingStore.set,
    clearRating: ratingStore.remove,
  };
}

/* ----------------------------- Ordered list store ----------------------------- */
//
// LRU-style ordered list of story ids the user has viewed. New entries
// push to the front; revisiting an existing entry moves it to the front;
// the list is capped at MAX_RECENT entries so the long tail truncates.
// This is the "Recently viewed" bucket the homepage uses for the future
// Picked-for-you / Continue surfaces.

const MAX_RECENT = 50;
const EMPTY_ORDERED: string[] = [];

interface OrderedListStore {
  subscribe: (cb: Listener) => () => void;
  getSnapshot: () => string[];
  getServerSnapshot: () => string[];
  /** Record a view. Idempotent within a session for the SAME id at the
   *  FRONT of the list — re-recording the same head id is a no-op so
   *  re-renders don't keep bumping `updatedAt` in the underlying store. */
  recordView: (id: string) => void;
  /** Remove an id (e.g., the user un-saved or deleted the story). */
  remove: (id: string) => void;
  /** Wipe the list — surfaced as a privacy control in Phase 6. */
  clear: () => void;
}

function createOrderedListStore(
  storageKey: string,
  max: number,
): OrderedListStore {
  let ids: string[] = [];
  let snapshot: string[] = EMPTY_ORDERED;
  const listeners = new Set<Listener>();
  let started = false;

  const readStorage = (): string[] => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr.filter((x): x is string => typeof x === "string").slice(0, max);
    } catch {
      return [];
    }
  };

  const refreshSnapshot = () => {
    snapshot = ids.slice();
  };

  const notify = () => listeners.forEach((l) => l());

  const persist = () => {
    if (!consentAccepted()) {
      console.info("[auth ui engagement-store consent-gated]", {
        storageKey,
        op: "persist",
      });
      return;
    }
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(ids));
    } catch {
      /* private mode / quota — in-memory state still updates */
    }
  };

  const start = () => {
    if (started || typeof window === "undefined") return;
    started = true;
    ids = readStorage();
    refreshSnapshot();
    window.addEventListener("storage", (e) => {
      if (e.key !== storageKey) return;
      ids = readStorage();
      refreshSnapshot();
      notify();
    });
  };

  return {
    subscribe(cb) {
      start();
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot() {
      return snapshot;
    },
    getServerSnapshot() {
      return EMPTY_ORDERED;
    },
    recordView(id) {
      start();
      if (!id) return;
      // No-op when the id is already at the front: protects against
      // re-render storms (the same effect firing on every parent
      // re-render would otherwise keep notifying subscribers).
      if (ids[0] === id) return;
      const without = ids.filter((x) => x !== id);
      ids = [id, ...without].slice(0, max);
      persist();
      refreshSnapshot();
      notify();
    },
    remove(id) {
      start();
      const next = ids.filter((x) => x !== id);
      if (next.length === ids.length) return;
      ids = next;
      persist();
      refreshSnapshot();
      notify();
    },
    clear() {
      start();
      if (ids.length === 0) return;
      ids = [];
      persist();
      refreshSnapshot();
      notify();
    },
  };
}

const recentlyViewedStore = createOrderedListStore(
  "lw.recently_viewed.v1",
  MAX_RECENT,
);

/** Recently viewed story ids in LRU order (most-recent first). */
export function useRecentlyViewed() {
  const viewed = useSyncExternalStore(
    recentlyViewedStore.subscribe,
    recentlyViewedStore.getSnapshot,
    recentlyViewedStore.getServerSnapshot,
  );
  return {
    viewed,
    recordView: recentlyViewedStore.recordView,
    remove: recentlyViewedStore.remove,
    clear: recentlyViewedStore.clear,
  };
}

/* ----------------------------- Continue reading store ----------------------------- */
//
// Per-story playback / read position so the homepage Continue rail and
// the future article reader can resume where the user left off. Keyed by
// story id. `positionMs` is set for video surfaces; `positionPct` (0-100)
// for article scroll. Both nullable — non-null exactly one at a time
// depending on the surface that wrote it.
//
// Thresholds (matched to the rule of thumb in the plan §Resolved):
//   - Don't record before 5 s OR 5% of article scroll — anything below
//     is noise from accidental opens.
//   - Mark `done` and drop from the rail past 90% of duration / scroll —
//     finished items shouldn't sit in "Continue" forever.
//
// The MAX_CONTINUE cap keeps the localStorage payload bounded; the rail
// only renders the most-recent N anyway.

const MAX_CONTINUE = 20;

export interface ContinueEntry {
  storyId: string;
  positionMs: number | null;
  positionPct: number | null;
  updatedAt: number;
}

const EMPTY_CONTINUE: ContinueEntry[] = [];

interface ContinueStore {
  subscribe: (cb: Listener) => () => void;
  getSnapshot: () => ContinueEntry[];
  getServerSnapshot: () => ContinueEntry[];
  /** Write or update progress for a story. Caller is responsible for
   *  passing positionMs OR positionPct (not both); see threshold notes. */
  set: (
    storyId: string,
    progress: { positionMs?: number; positionPct?: number },
  ) => void;
  /** Drop a story from the rail (the user finished it, or wants to
   *  remove it). */
  remove: (storyId: string) => void;
  /** Surfaced privacy control. */
  clear: () => void;
  /** Read a single story's saved position synchronously. */
  get: (storyId: string) => ContinueEntry | null;
}

function createContinueStore(storageKey: string, max: number): ContinueStore {
  let entries: ContinueEntry[] = [];
  let snapshot: ContinueEntry[] = EMPTY_CONTINUE;
  const listeners = new Set<Listener>();
  let started = false;

  const readStorage = (): ContinueEntry[] => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr
        .map((row): ContinueEntry | null => {
          if (!row || typeof row !== "object") return null;
          const r = row as Partial<ContinueEntry>;
          if (typeof r.storyId !== "string" || !r.storyId) return null;
          const positionMs =
            typeof r.positionMs === "number" && Number.isFinite(r.positionMs)
              ? r.positionMs
              : null;
          const positionPct =
            typeof r.positionPct === "number" && Number.isFinite(r.positionPct)
              ? r.positionPct
              : null;
          const updatedAt =
            typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt)
              ? r.updatedAt
              : 0;
          if (positionMs === null && positionPct === null) return null;
          return { storyId: r.storyId, positionMs, positionPct, updatedAt };
        })
        .filter((x): x is ContinueEntry => x !== null)
        .slice(0, max);
    } catch {
      return [];
    }
  };

  const refreshSnapshot = () => {
    snapshot = entries.slice();
  };

  const notify = () => listeners.forEach((l) => l());

  const persist = () => {
    if (!consentAccepted()) {
      console.info("[auth ui engagement-store consent-gated]", {
        storageKey,
        op: "persist",
      });
      return;
    }
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(entries));
    } catch {
      /* private mode / quota */
    }
  };

  const start = () => {
    if (started || typeof window === "undefined") return;
    started = true;
    entries = readStorage();
    refreshSnapshot();
    window.addEventListener("storage", (e) => {
      if (e.key !== storageKey) return;
      entries = readStorage();
      refreshSnapshot();
      notify();
    });
  };

  return {
    subscribe(cb) {
      start();
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot() {
      return snapshot;
    },
    getServerSnapshot() {
      return EMPTY_CONTINUE;
    },
    set(storyId, progress) {
      start();
      if (!storyId) return;
      const positionMs =
        typeof progress.positionMs === "number" &&
        Number.isFinite(progress.positionMs)
          ? progress.positionMs
          : null;
      const positionPct =
        typeof progress.positionPct === "number" &&
        Number.isFinite(progress.positionPct)
          ? progress.positionPct
          : null;
      if (positionMs === null && positionPct === null) return;
      const next: ContinueEntry = {
        storyId,
        positionMs,
        positionPct,
        updatedAt: Date.now(),
      };
      entries = [next, ...entries.filter((e) => e.storyId !== storyId)].slice(
        0,
        max,
      );
      persist();
      refreshSnapshot();
      notify();
    },
    remove(storyId) {
      start();
      const next = entries.filter((e) => e.storyId !== storyId);
      if (next.length === entries.length) return;
      entries = next;
      persist();
      refreshSnapshot();
      notify();
    },
    clear() {
      start();
      if (entries.length === 0) return;
      entries = [];
      persist();
      refreshSnapshot();
      notify();
    },
    get(storyId) {
      start();
      return entries.find((e) => e.storyId === storyId) ?? null;
    },
  };
}

const continueStore = createContinueStore("lw.continue.v1", MAX_CONTINUE);

/** Continue Watching / Reading — per-story progress.
 *  `entries` is sorted most-recent first (matches the rail render order).
 *  `set` is throttled by the caller; the player should call it on a 5 s
 *  cadence, not on every tick. */
export function useContinueReading() {
  const entries = useSyncExternalStore(
    continueStore.subscribe,
    continueStore.getSnapshot,
    continueStore.getServerSnapshot,
  );
  return {
    entries,
    ids: entries.map((e) => e.storyId),
    get: continueStore.get,
    set: continueStore.set,
    remove: continueStore.remove,
    clear: continueStore.clear,
  };
}
