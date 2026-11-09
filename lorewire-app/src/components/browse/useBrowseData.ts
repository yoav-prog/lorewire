// Data layer for the Browse + Search grids: fetch the first page of the full
// published catalog, then append pages from a compound keyset cursor on demand.
// Mirrors useWiresData (the Wires feed's pager) so the surfaces page identically
// and there's a single place that talks to listBrowseStories. Unlike the
// homepage rails' shared in-memory catalog (capped at 200), this pages the
// whole catalog so Browse and Search have no ceiling. Plans:
// _plans/2026-07-14-browse-pagination.md (Browse),
// _plans/2026-07-19-search-full-catalog.md (Search query pushdown).

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { listBrowseStories, type LiveCatalogStory } from "@/app/actions";

export interface BrowseData {
  stories: LiveCatalogStory[];
  /** Total eligible rows for the active category filter + query (server
   *  COUNT), or null until the first page lands. Drives the "N titles"
   *  header. */
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
 *  page.
 *  @param query Case-insensitive text filter on title/category, pushed down as
 *  a server-side WHERE so matches beyond any loaded page are found. Pass the
 *  DEBOUNCED search-box value (see useDebouncedValue); changing it refetches
 *  from the first page. */
export function useBrowseData(
  pageSize: number,
  categories: string[],
  query = "",
): BrowseData {
  const [stories, setStories] = useState<LiveCatalogStory[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  // Serialize the category selection so the effect dep is a primitive — a new
  // array identity each render would refetch on every render. Same for the
  // query: whitespace-only edits must not refetch.
  const categoriesKey = categories.join(",");
  const trimmedQuery = query.trim();

  // First page. Re-runs when the page size, category selection, or query
  // changes — reset to a clean loading state so the new filter refetches from
  // the top instead of appending onto the previous filter's list.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReachedEnd(false);
    setCursor(null);
    setStories([]);
    setTotal(null);
    listBrowseStories({
      limit: pageSize,
      categories,
      query: trimmedQuery,
      withTotal: true,
    })
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
  }, [pageSize, categoriesKey, trimmedQuery]);

  const loadMore = useCallback(() => {
    if (loadingMore || reachedEnd || cursor === null) return;
    setLoadingMore(true);
    listBrowseStories({
      limit: pageSize,
      beforeCursor: cursor,
      categories,
      query: trimmedQuery,
    })
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
  }, [loadingMore, reachedEnd, cursor, pageSize, categoriesKey, trimmedQuery]);

  return { stories, total, loading, loadingMore, reachedEnd, loadMore };
}

/** Debounce a fast-changing value (the search box) so each keystroke doesn't
 *  fire a server round trip — only the settled value reaches the pager. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/** Infinite scroll driver shared by the Browse + Search grids: observe a
 *  sentinel div kept below the grid and fire loadMore when it nears the
 *  viewport. The 600px rootMargin pre-fetches the next page before the user
 *  reaches the bottom so scrolling stays smooth; loadMore is a no-op while a
 *  fetch is in flight or the list is exhausted, so re-firing is safe. */
export function useLoadMoreSentinel(
  loadMore: () => void,
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);
  return ref;
}
