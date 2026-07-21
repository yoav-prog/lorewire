"use client";

// Same-session overlay of stories this browser has voted on. It exists for
// ONE reason: vote-gated surfaces (the homepage "You Didn't Vote Yet" rail)
// should update the instant you vote, not on the next refresh — the way
// likes and saves already do through engagement-store.
//
// Why this is separate from engagement-store and NOT persisted:
//   - The server already persists every vote by cookie and re-seeds the
//     authoritative `votedStoryIds` list on every page load
//     (homepage-data → loadVotedStoryIds → listVotedStoryIdsByCookie). So
//     the durable truth is already handled server-side.
//   - This store only needs to cover the gap BETWEEN casting a vote and the
//     next server read — i.e. this session. An in-memory module singleton
//     does exactly that: it survives client-side navigation (module state
//     persists across route changes) and is naturally re-seeded on a hard
//     reload, where the server list takes over again.
//   - Because nothing is written to disk, there's no consent gate to honor
//     and no PII sitting in localStorage. The shells UNION this session
//     overlay with the SSR `votedStoryIds` seed, so a story voted in a
//     previous session (server seed) and one voted in this session (overlay)
//     both filter out.
//
// Implemented with useSyncExternalStore so SSR and the first client paint
// both see an empty overlay (the SSR seed carries prior votes), with no
// hydration mismatch. Mirrors the mark-once store shape in
// components/stories/use-viewed-wires.ts.

import { useSyncExternalStore } from "react";

// Stable empty reference for the server / first-paint snapshot so
// useSyncExternalStore never loops.
const EMPTY: string[] = [];

type Listener = () => void;

interface VotedStore {
  subscribe: (cb: Listener) => () => void;
  getSnapshot: () => string[];
  getServerSnapshot: () => string[];
  /** Record a vote. Idempotent — a second mark for the same id is a no-op,
   *  so re-votes / duplicate success handlers don't churn subscribers. */
  mark: (id: string) => void;
  has: (id: string) => boolean;
}

function createVotedStore(): VotedStore {
  const ids = new Set<string>();
  // Cached array so getSnapshot returns a stable reference between changes.
  let snapshot: string[] = EMPTY;
  const listeners = new Set<Listener>();

  const notify = () => listeners.forEach((l) => l());

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
    mark(id) {
      if (!id || ids.has(id)) return;
      ids.add(id);
      snapshot = Array.from(ids);
      notify();
    },
    has(id) {
      return ids.has(id);
    },
  };
}

const votedStore = createVotedStore();

/** Write-only entry point for the vote widgets (PollWidget / WirePollPanel).
 *  Call after a successful vote so every vote-gated surface reacts this
 *  session. Safe to call with an empty id (no-op) and idempotent. */
export function markVotedStory(id: string): void {
  votedStore.mark(id);
}

/** Session overlay of story ids voted on in THIS session. The homepage
 *  shells union this with the SSR `votedStoryIds` seed to drive the
 *  "You Didn't Vote Yet" rail without a refresh. */
export function useVotedStories(): {
  voted: string[];
  hasVoted: (id: string) => boolean;
} {
  const voted = useSyncExternalStore(
    votedStore.subscribe,
    votedStore.getSnapshot,
    votedStore.getServerSnapshot,
  );
  return {
    voted,
    hasVoted: (id: string) => voted.includes(id),
  };
}

/** Test-only escape hatch: exposes the raw store so unit tests can exercise
 *  mark/has/subscribe without a React renderer (the pattern the rest of the
 *  stores use). Consumers should always go through the exports above. */
export const __votedStoreForTests = votedStore;
