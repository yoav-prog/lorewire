"use client";

// Persisted viewer preferences for the Wires feed: the autoplay master toggle,
// the mute state, and the end-of-wire behavior (advance to the next wire vs.
// loop the current one). All live in localStorage and are consent-gated the
// same way the engagement stores are — a visitor who declined persistence still
// gets the toggles in-session, but nothing is written to disk. Defaults:
// autoplay ON, muted ON (required for unattended autoplay), advance ON.
//
// Implemented with useSyncExternalStore (the same pattern as engagement-store)
// so SSR and the first client paint both see the defaults — the stored value
// surfaces on subscribe without a set-state-in-effect or a hydration mismatch.

import { useSyncExternalStore } from "react";

const AUTOPLAY_KEY = "lw.wires.autoplay.v1";
const MUTED_KEY = "lw.wires.muted.v1";
const ADVANCE_KEY = "lw.wires.advance.v1";

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

export interface WirePrefs {
  autoplay: boolean;
  muted: boolean;
  /** End-of-wire behavior: true = advance to the next wire, false = loop. */
  advance: boolean;
  setAutoplay: (v: boolean) => void;
  toggleAutoplay: () => void;
  setMuted: (v: boolean) => void;
  toggleMuted: () => void;
  setAdvance: (v: boolean) => void;
  toggleAdvance: () => void;
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
  return {
    autoplay,
    muted,
    advance,
    setAutoplay: autoplayStore.set,
    toggleAutoplay: () => autoplayStore.set(!autoplayStore.getSnapshot()),
    setMuted: mutedStore.set,
    toggleMuted: () => mutedStore.set(!mutedStore.getSnapshot()),
    setAdvance: advanceStore.set,
    toggleAdvance: () => advanceStore.set(!advanceStore.getSnapshot()),
  };
}
