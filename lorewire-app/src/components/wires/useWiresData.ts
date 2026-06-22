// Shared data layer for both reels surfaces (mobile ReelsFeed + desktop
// ReelsDesktop): fetch the first page of published shorts, then append pages
// from the cursor on demand. Keeping this in one hook means the two surfaces
// page identically and there's a single place that talks to listPublishedShorts.

import { useCallback, useEffect, useState } from "react";
import { listPublishedShorts, type LiveCatalogStory } from "@/app/actions";

export interface ReelsData {
  shorts: LiveCatalogStory[];
  loading: boolean;
  loadingMore: boolean;
  reachedEnd: boolean;
  /** Append the next page. No-op while a fetch is in flight or the list is
   *  exhausted, so callers can fire it liberally as the active card nears the
   *  tail. */
  loadMore: () => void;
}

export function useReelsData(pageSize: number): ReelsData {
  const [shorts, setShorts] = useState<LiveCatalogStory[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  // First page. `loading` already starts true, so no setState up front.
  useEffect(() => {
    let cancelled = false;
    listPublishedShorts({ limit: pageSize })
      .then((r) => {
        if (cancelled) return;
        setShorts(r.shorts);
        setCursor(r.nextCursor);
        setReachedEnd(r.nextCursor === null);
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn("[reels feed load err]", String(e));
        setReachedEnd(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pageSize]);

  const loadMore = useCallback(() => {
    if (loadingMore || reachedEnd || cursor === null) return;
    setLoadingMore(true);
    listPublishedShorts({ limit: pageSize, beforePublishedAt: cursor })
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
        console.warn("[reels feed loadMore err]", String(e));
        setReachedEnd(true);
      })
      .finally(() => setLoadingMore(false));
  }, [loadingMore, reachedEnd, cursor, pageSize]);

  return { shorts, loading, loadingMore, reachedEnd, loadMore };
}
