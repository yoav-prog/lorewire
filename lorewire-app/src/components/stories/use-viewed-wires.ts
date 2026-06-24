"use client";

// Per-browser "seen" set for the IG-style Stories viewer. Distinct from
// engagement-store's useRecentlyViewed (which records every OPEN
// regardless of completion) and useContinueReading (per-story progress
// for resume). useViewedWires answers exactly one question: did the
// user finish, or genuinely dwell on, this wire in the Stories viewer?
// The Stories rail filters its playlist through this set so already-
// consumed wires drop out of "what's new."
//
// Shape choices:
//   - mark() is idempotent (add-only). Viewing isn't a toggle — a
//     second mark for the same id is a no-op. clear() is the only way
//     out, surfaced as a "reset stories I've seen" privacy control.
//   - Consent-gated identically to the rest of engagement-store: the
//     in-memory Set still updates when consent is missing so the rail's
//     unseen ring reflects the current session, but the localStorage
//     write is skipped — a refresh wipes anything tried in that window.
//   - When real accounts land, swap the localStorage read/write in
//     createMarkOnceStore for a server call; useViewedWires's surface
//     does not change. The Set is an additive shape, so per-account
//     sync is a union on conflict (no last-writer-wins risk).
//
// Plan: _plans/2026-06-25-stories-rail-and-viewer.md.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "lw.viewed_wires.v1";
const EMPTY: string[] = [];

type Listener = () => void;

/** True when the lw_consent cookie says "accepted". Mirrors the helper
 *  in engagement-store so persistence here obeys the same gate without
 *  cross-module coupling. */
function consentAccepted(): boolean {
  if (typeof document === "undefined") return false;
  for (const pair of document.cookie.split("; ")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== "lw_consent") continue;
    return decodeURIComponent(pair.slice(eq + 1)) === "accepted";
  }
  return false;
}

interface MarkOnceStore {
  subscribe: (cb: Listener) => () => void;
  getSnapshot: () => string[];
  getServerSnapshot: () => string[];
  mark: (id: string) => void;
  has: (id: string) => boolean;
  clear: () => void;
}

function createMarkOnceStore(storageKey: string): MarkOnceStore {
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
        Array.isArray(arr)
          ? arr.filter((x): x is string => typeof x === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  };

  const refreshSnapshot = () => {
    snapshot = Array.from(ids);
  };

  const notify = () => listeners.forEach((l) => l());

  const persist = () => {
    if (!consentAccepted()) {
      // eslint-disable-next-line no-console -- rule 14
      console.info("[stories viewed consent-gated]", { storageKey });
      return;
    }
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(Array.from(ids)));
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
      return EMPTY;
    },
    mark(id) {
      start();
      if (!id || ids.has(id)) return;
      ids.add(id);
      persist();
      refreshSnapshot();
      notify();
    },
    has(id) {
      return ids.has(id);
    },
    clear() {
      start();
      if (ids.size === 0) return;
      ids = new Set();
      persist();
      refreshSnapshot();
      notify();
    },
  };
}

const viewedWiresStore = createMarkOnceStore(STORAGE_KEY);

/** React hook reading the "seen" set. Drives the Stories rail's unread
 *  ring and the viewer's "mark on complete or dwell-advance" call. */
export function useViewedWires() {
  const viewed = useSyncExternalStore(
    viewedWiresStore.subscribe,
    viewedWiresStore.getSnapshot,
    viewedWiresStore.getServerSnapshot,
  );
  return {
    viewed,
    isViewed: (id: string) => viewed.includes(id),
    markViewed: viewedWiresStore.mark,
    clearViewed: viewedWiresStore.clear,
  };
}

/** Test-only escape hatch: exposes the raw store so unit tests can
 *  exercise mark/clear/subscribe without spinning up a React renderer
 *  (no @testing-library is set up in this codebase). Not part of the
 *  runtime surface; consumers should always go through useViewedWires(). */
export const __viewedWiresStoreForTests = viewedWiresStore;
