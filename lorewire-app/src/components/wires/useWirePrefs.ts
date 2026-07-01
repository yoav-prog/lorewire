"use client";

// Persisted viewer preferences for the Wires feed: the autoplay master toggle,
// the mute state, the end-of-wire behavior (advance to the next wire vs.
// loop the current one), and Slow mode (0.75x playback for users who find
// the default pace too fast). All live in localStorage and are consent-gated
// the same way the engagement stores are — a visitor who declined persistence
// still gets the toggles in-session, but nothing is written to disk. Defaults:
// autoplay ON, muted ON (required for unattended autoplay), advance ON,
// slow OFF (opt-in for accessibility).
//
// Slow mode also applies to the Stories video viewer; the slow store is read
// directly by StoriesViewer so the two surfaces agree on one toggle. Plan:
// _plans/2026-06-25-slow-mode-playback.md.
//
// Implemented with useSyncExternalStore (the same pattern as engagement-store)
// so SSR and the first client paint both see the defaults — the stored value
// surfaces on subscribe without a set-state-in-effect or a hydration mismatch.

import { useSyncExternalStore } from "react";

const AUTOPLAY_KEY = "lw.wires.autoplay.v1";
const MUTED_KEY = "lw.wires.muted.v1";
const ADVANCE_KEY = "lw.wires.advance.v1";
const SLOW_KEY = "lw.wires.slow.v1";
const HIDE_VOTED_KEY = "lw.wires.hide_voted.v1";

/** Slow-mode playback rate. 0.75x is the sweet spot — noticeably calmer
 *  while keeping voices intelligible with preservesPitch enabled. */
export const SLOW_MODE_PLAYBACK_RATE = 0.75;

type Listener = () => void;

/** True when the lw_consent cookie says "accepted". Mirrors the helper in
 *  engagement-store so persistence here obeys the same gate. */
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

interface BoolStore {
  subscribe: (cb: Listener) => () => void;
  getSnapshot: () => boolean;
  getServerSnapshot: () => boolean;
  set: (value: boolean) => void;
}

function createBoolStore(storageKey: string, fallback: boolean): BoolStore {
  let value = fallback;
  let started = false;
  const listeners = new Set<Listener>();

  const read = (): boolean => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw === null ? fallback : raw === "1";
    } catch {
      return fallback;
    }
  };

  const notify = () => listeners.forEach((l) => l());

  // Hydrate from localStorage on first subscribe and keep in sync across tabs.
  const start = () => {
    if (started || typeof window === "undefined") return;
    started = true;
    value = read();
    window.addEventListener("storage", (e) => {
      if (e.key !== storageKey) return;
      value = read();
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
      return value;
    },
    getServerSnapshot() {
      return fallback;
    },
    set(next) {
      start();
      value = next;
      // Consent gate: persist only when accepted; the in-memory value still
      // flips so the toggle responds immediately this session.
      if (consentAccepted()) {
        try {
          window.localStorage.setItem(storageKey, next ? "1" : "0");
        } catch {
          /* private mode / quota — in-memory value still updates */
        }
      }
      notify();
    },
  };
}

const autoplayStore = createBoolStore(AUTOPLAY_KEY, true);
const mutedStore = createBoolStore(MUTED_KEY, true);
// advance = true → move to the next wire when one ends; false → loop it.
const advanceStore = createBoolStore(ADVANCE_KEY, true);
// slow = true → playback runs at SLOW_MODE_PLAYBACK_RATE instead of 1.0x.
// Default OFF — the slow speed is opt-in accessibility, not the brand default.
const slowStore = createBoolStore(SLOW_KEY, false);
// hideVoted = true → the feed shows only wires the viewer hasn't voted on yet
// (the server applies the filter via listPublishedShorts' onlyUnvoted param).
// Default ON — the request was for "unvoted first," with a toggle to see all.
const hideVotedStore = createBoolStore(HIDE_VOTED_KEY, true);

export interface WirePrefs {
  autoplay: boolean;
  muted: boolean;
  /** End-of-wire behavior: true = advance to the next wire, false = loop. */
  advance: boolean;
  /** Slow mode: true = 0.75x playback for an easier pace; false = 1.0x. */
  slow: boolean;
  /** Only-unvoted filter: true = show only wires the viewer hasn't voted on
   *  yet (the default); false = show every published wire. */
  hideVoted: boolean;
  setAutoplay: (v: boolean) => void;
  toggleAutoplay: () => void;
  setMuted: (v: boolean) => void;
  toggleMuted: () => void;
  setAdvance: (v: boolean) => void;
  toggleAdvance: () => void;
  setSlow: (v: boolean) => void;
  toggleSlow: () => void;
  setHideVoted: (v: boolean) => void;
  toggleHideVoted: () => void;
}

export function useWirePrefs(): WirePrefs {
  const autoplay = useSyncExternalStore(
    autoplayStore.subscribe,
    autoplayStore.getSnapshot,
    autoplayStore.getServerSnapshot,
  );
  const muted = useSyncExternalStore(
    mutedStore.subscribe,
    mutedStore.getSnapshot,
    mutedStore.getServerSnapshot,
  );
  const advance = useSyncExternalStore(
    advanceStore.subscribe,
    advanceStore.getSnapshot,
    advanceStore.getServerSnapshot,
  );
  const slow = useSyncExternalStore(
    slowStore.subscribe,
    slowStore.getSnapshot,
    slowStore.getServerSnapshot,
  );
  const hideVoted = useSyncExternalStore(
    hideVotedStore.subscribe,
    hideVotedStore.getSnapshot,
    hideVotedStore.getServerSnapshot,
  );
  return {
    autoplay,
    muted,
    advance,
    slow,
    hideVoted,
    setAutoplay: autoplayStore.set,
    toggleAutoplay: () => autoplayStore.set(!autoplayStore.getSnapshot()),
    setMuted: mutedStore.set,
    toggleMuted: () => mutedStore.set(!mutedStore.getSnapshot()),
    setAdvance: advanceStore.set,
    toggleAdvance: () => advanceStore.set(!advanceStore.getSnapshot()),
    setSlow: slowStore.set,
    toggleSlow: () => slowStore.set(!slowStore.getSnapshot()),
    setHideVoted: hideVotedStore.set,
    toggleHideVoted: () => hideVotedStore.set(!hideVotedStore.getSnapshot()),
  };
}
