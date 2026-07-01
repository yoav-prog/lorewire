// Shared data layer for both wires surfaces (mobile WiresFeed + desktop
// WiresDesktop): fetch the first page of published shorts, then append pages
// from the cursor on demand. Keeping this in one hook means the two surfaces
// page identically and there's a single place that talks to listPublishedShorts.

import { useCallback, useEffect, useState } from "react";
import { listPublishedShorts, type WireStory } from "@/app/actions";

export interface WiresData {
  shorts: WireStory[];
  loading: boolean;
  loadingMore: boolean;
  reachedEnd: boolean;
  /** Append the next page. No-op while a fetch is in flight or the list is
   *  exhausted, so callers can fire it liberally as the active card nears the
   *  tail. */
  loadMore: () => void;
}

/** @param onlyUnvoted When true, the feed shows only wires the viewer hasn't
 *  voted on yet (server-filtered). Flipping it refetches the feed from the
 *  first page. */
export function useWiresData(pageSize: number, onlyUnvoted: boolean): WiresData {
  const [shorts, setShorts] = useState<WireStory[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  // First page. Re-runs when `onlyUnvoted` flips (the toggle) — reset the feed
  // to a clean loading state so the new filter refetches from the top instead
  // of appending onto the previous mode's list.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReachedEnd(false);
    setCursor(null);
    setShorts([]);
    listPublishedShorts({ limit: pageSize, onlyUnvoted })
      .then((r) => {
        if (cancelled) return;
        setShorts(r.shorts);
        setCursor(r.nextCursor);
        setReachedEnd(r.nextCursor === null);
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn("[wires feed load err]", String(e));
        setReachedEnd(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pageSize, onlyUnvoted]);

  const loadMore = useCallback(() => {
    if (loadingMore || reachedEnd || cursor === null) return;
    setLoadingMore(true);
    listPublishedShorts({ limit: pageSize, beforePublishedAt: cursor, onlyUnvoted })
      .then((r) => {
        setShorts((prev) => {
          // Dedupe by id in case a row straddles the cursor boundary.
          const seen = new Set(prev.map((s) => s.id));
          return [...prev, ...r.shorts.filter((s) => !seen.has(s.id))];
        });
        setCursor(r.nextCursor);
        if (r.nextCursor === null) setReachedEnd(true);
      })
      .catch((e) => {
        console.warn("[wires feed loadMore err]", String(e));
        setReachedEnd(true);
      })
      .finally(() => setLoadingMore(false));
  }, [loadingMore, reachedEnd, cursor, pageSize, onlyUnvoted]);

  return { shorts, loading, loadingMore, reachedEnd, loadMore };
}
