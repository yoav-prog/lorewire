// Data layer for the Browse grid: fetch the first page of the full published
// catalog, then append pages from a compound keyset cursor on demand. Mirrors
// useWiresData (the Wires feed's pager) so the two surfaces page identically and
// there's a single place that talks to listBrowseStories. Unlike the homepage
// rails' shared in-memory catalog (capped at 200), this pages the whole catalog
// so Browse has no ceiling. Plan: _plans/2026-07-14-browse-pagination.md.

import { useCallback, useEffect, useState } from "react";
import { listBrowseStories, type LiveCatalogStory } from "@/app/actions";

export interface BrowseData {
  stories: LiveCatalogStory[];
  /** Total eligible rows for the active category filter (server COUNT), or null
   *  until the first page lands. Drives the "N titles" header. */
  total: number | null;
  loading: boolean;
  loadingMore: boolean;
  reachedEnd: boolean;
  /** Append the next page. No-op while a fetch is in flight or the list is
   *  exhausted, so the scroll sentinel can fire it liberally. */
  loadMore: () => void;
}

/** @param pageSize Rows per page (clamped 1..100 server-side).
 *  @param categories Exact `stories.category` labels to restrict to. Must be a
 *  STABLE, sorted reference (derived from the URL-backed category filter) so it
 *  can drive the refetch dep directly. Changing it refetches from the first
 *  page. */
export function useBrowseData(
  pageSize: number,
  categories: string[],
): BrowseData {
  const [stories, setStories] = useState<LiveCatalogStory[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  // Serialize the category selection so the effect dep is a primitive — a new
  // array identity each render would refetch on every render.
  const categoriesKey = categories.join(",");

  // First page. Re-runs when the page size or category selection changes — reset
  // to a clean loading state so the new filter refetches from the top instead of
  // appending onto the previous filter's list.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReachedEnd(false);
    setCursor(null);
    setStories([]);
    setTotal(null);
    listBrowseStories({ limit: pageSize, categories, withTotal: true })
      .then((r) => {
        if (cancelled) return;
        setStories(r.stories);
        setCursor(r.nextCursor);
        setTotal(r.total);
        setReachedEnd(r.nextCursor === null);
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn("[browse load err]", String(e));
        setReachedEnd(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // categoriesKey drives the refetch; `categories` is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize, categoriesKey]);

  const loadMore = useCallback(() => {
    if (loadingMore || reachedEnd || cursor === null) return;
    setLoadingMore(true);
    listBrowseStories({ limit: pageSize, beforeCursor: cursor, categories })
      .then((r) => {
        setStories((prev) => {
          // Dedupe by id in case a row straddles the cursor boundary.
          const seen = new Set(prev.map((s) => s.id));
          return [...prev, ...r.stories.filter((s) => !seen.has(s.id))];
        });
        setCursor(r.nextCursor);
        if (r.nextCursor === null) setReachedEnd(true);
      })
      .catch((e) => {
        console.warn("[browse loadMore err]", String(e));
        setReachedEnd(true);
      })
      .finally(() => setLoadingMore(false));
    // categoriesKey drives identity; `categories` is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingMore, reachedEnd, cursor, pageSize, categoriesKey]);

  return { stories, total, loading, loadingMore, reachedEnd, loadMore };
}
