"use client";

// Server-backed likes for the Wires feed. Replaces the local-only heart: the
// source of truth is the user_likes table (one row per viewer per story),
// surfaced through the toggleLikeStory action. This hook holds an in-memory
// map of { liked, count } per story, seeded from the server rows the feed
// already fetched, and reconciles every toggle against the server response.
//
// Optimism: the heart flips and the count nudges instantly; the server result
// then replaces the optimistic value (or reverts it on error). When the viewer
// has no consent/identity the action returns persisted:false and the count
// snaps back to the real public number, so the UI never lies about totals.

import { useCallback, useEffect, useRef, useState } from "react";
import { toggleLikeStory, type WireStory } from "@/app/actions";

export interface WireLikeState {
  liked: boolean;
  count: number;
}

export interface WireLikes {
  /** Seed state from a freshly-loaded page WITHOUT clobbering optimistic edits
   *  the viewer already made this session. */
  seed: (rows: WireStory[]) => void;
  /** Flip this viewer's like for a story (optimistic + server reconcile). */
  toggle: (storyId: string) => void;
  /** Current state for a story, or undefined before it has been seeded. */
  get: (storyId: string) => WireLikeState | undefined;
}

export function useWireLikes(): WireLikes {
  const [map, setMap] = useState<Record<string, WireLikeState>>({});
  // Mirror the latest map so rapid sequential toggles read fresh state without
  // waiting for a re-render.
  const mapRef = useRef(map);
  useEffect(() => {
    mapRef.current = map;
  }, [map]);

  const seed = useCallback((rows: WireStory[]) => {
    setMap((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const r of rows) {
        // Don't overwrite an entry the viewer has already interacted with —
        // their optimistic/server-confirmed state wins over a refetch.
        if (!(r.id in next)) {
          next[r.id] = { liked: r.viewer_liked, count: r.like_count };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const toggle = useCallback((storyId: string) => {
    const cur = mapRef.current[storyId] ?? { liked: false, count: 0 };
    const nextLiked = !cur.liked;
    const optimistic: WireLikeState = {
      liked: nextLiked,
      count: Math.max(0, cur.count + (nextLiked ? 1 : -1)),
    };
    // Apply optimistic state and keep the ref in lockstep for back-to-back taps.
    mapRef.current = { ...mapRef.current, [storyId]: optimistic };
    setMap((m) => ({ ...m, [storyId]: optimistic }));

    toggleLikeStory(storyId, nextLiked)
      .then((res) => {
        if (!res.ok) {
          // Server refused (bad id) — revert to the pre-click state.
          setMap((m) => ({ ...m, [storyId]: cur }));
          mapRef.current = { ...mapRef.current, [storyId]: cur };
          return;
        }
        const confirmed: WireLikeState = { liked: res.liked, count: res.count };
        setMap((m) => ({ ...m, [storyId]: confirmed }));
        mapRef.current = { ...mapRef.current, [storyId]: confirmed };
      })
      .catch((e) => {
        console.warn("[wires like err]", { storyId, e: String(e) });
        setMap((m) => ({ ...m, [storyId]: cur }));
        mapRef.current = { ...mapRef.current, [storyId]: cur };
      });
  }, []);

  const get = useCallback(
    (storyId: string): WireLikeState | undefined => map[storyId],
    [map],
  );

  return { seed, toggle, get };
}
