"use client";

// Stories-mode user preferences. Two persisted, consent-gated stores:
//
//   - useStoriesAutoAdvance — boolean, default true. When false, the
//     viewer never advances on its own; users tap / swipe.
//   - useStoriesImageDwellMs — number, default 6000ms (IG default).
//     Choices clamp to {4000, 6000, 8000, 10000}; out-of-set values
//     reset to the default. Only affects image / text-only wires;
//     video wires always advance on the video's `ended` event.
//
// Mirrors the consent-gated useSyncExternalStore pattern from
// useWirePrefs.ts — SSR and the first client paint both see the
// defaults; the stored value surfaces on subscribe without a
// set-state-in-effect or a hydration mismatch.
//
// Plan: _plans/2026-06-25-user-settings-page.md.

import { useSyncExternalStore } from "react";

const AUTOADVANCE_KEY = "lw.stories.autoadvance.v1";
const IMAGE_DWELL_KEY = "lw.stories.image_dwell_ms.v1";

export const DEFAULT_STORIES_AUTOADVANCE = true;
export const DEFAULT_STORIES_IMAGE_DWELL_MS = 6000;

/** The closed set of legal dwell values shown in the Settings UI.
 *  Exposed for the settings page so the choices stay in sync with the
 *  store's clamp behavior. */
export const STORIES_IMAGE_DWELL_CHOICES = [4000, 6000, 8000, 10000] as const;
export type StoriesImageDwellMs = (typeof STORIES_IMAGE_DWELL_CHOICES)[number];

type Listener = () => void;

/** True when the lw_consent cookie says "accepted". Mirrors the
 *  helper in useWirePrefs / engagement-store so persistence here
 *  obeys the same gate without cross-module coupling. */
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

interface NumStore {
  subscribe: (cb: Listener) => () => void;
  getSnapshot: () => number;
  getServerSnapshot: () => number;
  set: (value: number) => void;
}

/** Coerce an arbitrary value into one of the legal dwell choices.
 *  Out-of-set values fall back to the default. Exposed for tests. */
export function clampDwell(n: unknown): StoriesImageDwellMs {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return DEFAULT_STORIES_IMAGE_DWELL_MS;
  }
  for (const choice of STORIES_IMAGE_DWELL_CHOICES) {
    if (choice === n) return choice;
  }
  return DEFAULT_STORIES_IMAGE_DWELL_MS;
}

function createDwellStore(storageKey: string): NumStore {
  let value: number = DEFAULT_STORIES_IMAGE_DWELL_MS;
  let started = false;
  const listeners = new Set<Listener>();

  const read = (): number => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) return DEFAULT_STORIES_IMAGE_DWELL_MS;
      const parsed = Number.parseInt(raw, 10);
      return clampDwell(parsed);
    } catch {
      return DEFAULT_STORIES_IMAGE_DWELL_MS;
    }
  };

  const notify = () => listeners.forEach((l) => l());

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
      return DEFAULT_STORIES_IMAGE_DWELL_MS;
    },
    set(next) {
      start();
      value = clampDwell(next);
      if (consentAccepted()) {
        try {
          window.localStorage.setItem(storageKey, String(value));
        } catch {
          /* private mode / quota — in-memory value still updates */
        }
      }
      notify();
    },
  };
}

const autoAdvanceStore = createBoolStore(
  AUTOADVANCE_KEY,
  DEFAULT_STORIES_AUTOADVANCE,
);
const imageDwellStore = createDwellStore(IMAGE_DWELL_KEY);

/** Stories auto-advance toggle. When false the viewer never advances
 *  on its own; users tap / swipe / use keyboard. Matches the existing
 *  prefers-reduced-motion short-circuit in StoriesViewer. */
export function useStoriesAutoAdvance(): {
  autoAdvance: boolean;
  setAutoAdvance: (v: boolean) => void;
  toggleAutoAdvance: () => void;
} {
  const autoAdvance = useSyncExternalStore(
    autoAdvanceStore.subscribe,
    autoAdvanceStore.getSnapshot,
    autoAdvanceStore.getServerSnapshot,
  );
  return {
    autoAdvance,
    setAutoAdvance: autoAdvanceStore.set,
    toggleAutoAdvance: () => autoAdvanceStore.set(!autoAdvanceStore.getSnapshot()),
  };
}

/** Stories image dwell in ms — how long an image-only wire stays
 *  on screen before the auto-advance timer fires. Video wires
 *  ignore this; they always advance on `ended`. */
export function useStoriesImageDwellMs(): {
  imageDwellMs: number;
  setImageDwellMs: (ms: number) => void;
} {
  const imageDwellMs = useSyncExternalStore(
    imageDwellStore.subscribe,
    imageDwellStore.getSnapshot,
    imageDwellStore.getServerSnapshot,
  );
  return {
    imageDwellMs,
    setImageDwellMs: imageDwellStore.set,
  };
}

/** Test-only escape hatch: exposes the raw stores so unit tests can
 *  exercise the set/get/clamp paths without spinning up a React
 *  renderer (no @testing-library set up — same workaround the rest
 *  of the codebase uses). Not part of the runtime surface. */
export const __storiesPrefsStoresForTests = {
  autoAdvance: autoAdvanceStore,
  imageDwell: imageDwellStore,
};
