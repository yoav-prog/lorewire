"use client";

// In-memory selection of granular category slugs the viewer is filtering the
// Wires feed by. Session-scoped on purpose: it's a browsing filter, not a saved
// preference — a category filter that silently persists across reloads reads as
// "why am I only seeing two categories?" A module singleton, so the selection
// survives switching tabs within the SPA (the feed unmounts when you leave the
// Wires tab) but resets on a hard reload. Mirrors the useSyncExternalStore idiom
// the rest of the wires stores use.

import { useSyncExternalStore } from "react";

const EMPTY: string[] = [];
type Listener = () => void;

interface CategoryFilterStore {
  subscribe: (cb: Listener) => () => void;
  getSnapshot: () => string[];
  getServerSnapshot: () => string[];
  toggle: (slug: string) => void;
  clear: () => void;
  has: (slug: string) => boolean;
}

function createCategoryFilterStore(): CategoryFilterStore {
  const slugs = new Set<string>();
  // Cached, sorted array so getSnapshot returns a stable reference between edits
  // (useSyncExternalStore relies on this) and the ordering is deterministic so a
  // {a,b} vs {b,a} selection produces the same refetch dep.
  let snapshot: string[] = EMPTY;
  const listeners = new Set<Listener>();

  const notify = () => listeners.forEach((l) => l());
  const refresh = () => {
    snapshot = Array.from(slugs).sort();
  };

  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot() {
      return snapshot;
    },
    getServerSnapshot() {
      return EMPTY;
    },
    toggle(slug) {
      if (!slug) return;
      if (slugs.has(slug)) slugs.delete(slug);
      else slugs.add(slug);
      refresh();
      notify();
    },
    clear() {
      if (slugs.size === 0) return;
      slugs.clear();
      refresh();
      notify();
    },
    has(slug) {
      return slugs.has(slug);
    },
  };
}

const store = createCategoryFilterStore();

export interface WireCategoryFilter {
  /** Selected slugs, sorted (stable reference between edits). */
  selected: string[];
  isSelected: (slug: string) => boolean;
  toggle: (slug: string) => void;
  clear: () => void;
}

export function useWireCategoryFilter(): WireCategoryFilter {
  const selected = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  return {
    selected,
    isSelected: (slug: string) => selected.includes(slug),
    toggle: store.toggle,
    clear: store.clear,
  };
}

/** Test-only escape hatch: the raw store, for exercising toggle/clear/subscribe
 *  without a React renderer (the pattern the other wires stores use). */
export const __wireCategoryFilterStoreForTests = store;
