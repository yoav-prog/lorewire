// Local, honest engagement for the Reels feed + My List. No consumer accounts
// exist, so "liked" and "saved" live in THIS browser only (localStorage) — we
// never show fabricated social counts. Saved stories ARE the My List: one
// external store is shared by the feed's Save button, the My List tab, and the
// Title sheet so every surface stays in sync and survives a refresh.
//
// When real accounts land, swap the localStorage read/write inside the store
// for a server call; the component API (useSavedStories / useLikedReels) does
// not change. That's the "pre-instrument now" path from the plan.

import { useSyncExternalStore } from "react";

type Listener = () => void;

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
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(Array.from(ids)));
      } catch {
        /* private mode / quota — keep the in-memory toggle so the UI still flips */
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

/** Liked reels — a local heart, no fabricated count. */
export function useLikedReels() {
  const liked = useIdSet(likedStore);
  return {
    liked,
    isLiked: (id: string) => liked.includes(id),
    toggle: likedStore.toggle,
  };
}
