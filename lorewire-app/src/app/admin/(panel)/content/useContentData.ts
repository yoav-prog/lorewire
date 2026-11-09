"use client";

// Client pager for the Content inbox: fetch the first keyset page for the
// active filters + search, then append pages on demand from the compound
// cursor. Mirrors useBrowseData / useWiresData (the house pagination hook) so
// every paged surface behaves identically and there's one place that talks to
// listContentPageAction. Filters + search arrive as `opts` (derived from the
// URL by the server page); changing them refetches from the first page.
// Plan: _plans/2026-07-15-content-pagination-and-bulk-safety.md.

import { useCallback, useEffect, useState } from "react";
import { listContentPageAction } from "@/app/admin/actions";
import type { ContentPageOpts, ContentRow } from "@/lib/repo";

const PAGE_SIZE = 100;

export interface ContentData {
  /** Rows accumulated across the pages loaded so far, newest-first. */
  rows: ContentRow[];
  /** Total rows matching the active filters (server COUNT), or null until the
   *  first page lands. Drives the "N of M" header. */
  total: number | null;
  loading: boolean;
  loadingMore: boolean;
  reachedEnd: boolean;
  /** Append the next page. No-op while a fetch is in flight or the list is
   *  exhausted. */
  loadMore: () => void;
  /** Re-fetch the loaded window in place (no empty flash, cursor preserved) so
   *  in-flight render progress ticks without a manual reload. Drives
   *  AutoRefresh. */
  refresh: () => void;
}

export function useContentData(opts: ContentPageOpts): ContentData {
  const [rows, setRows] = useState<ContentRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  // Serialize the filter/search opts so the effect dep is a primitive — a fresh
  // object identity each render would refetch on every render.
  const optsKey = JSON.stringify(opts);

  // First page. Re-runs when the filters or search change: reset to a clean
  // loading state so the new query refetches from the top rather than appending
  // onto the previous result.
  useEffect(() => {
    let cancelled = false;
    // Intentional reset-then-fetch when the query changes — the data-fetching
    // idiom the house pager (useBrowseData) uses. The rule targets derived
    // state, not fetch effects.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setReachedEnd(false);
    setCursor(null);
    setRows([]);
    setTotal(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    listContentPageAction({ ...opts, limit: PAGE_SIZE, withTotal: true })
      .then((r) => {
        if (cancelled) return;
        setRows(r.rows);
        setCursor(r.nextCursor);
        setTotal(r.total);
        setReachedEnd(r.nextCursor === null);
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn("[content load err]", String(e));
        setReachedEnd(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // optsKey drives the refetch; `opts` is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optsKey]);

  const loadMore = useCallback(() => {
    if (loadingMore || reachedEnd || cursor === null) return;
    setLoadingMore(true);
    listContentPageAction({ ...opts, limit: PAGE_SIZE, cursor })
      .then((r) => {
        setRows((prev) => {
          // Dedupe by kind:id in case a row straddles the cursor boundary.
          const seen = new Set(prev.map((s) => `${s.kind}:${s.id}`));
          return [
            ...prev,
            ...r.rows.filter((s) => !seen.has(`${s.kind}:${s.id}`)),
          ];
        });
        setCursor(r.nextCursor);
        if (r.nextCursor === null) setReachedEnd(true);
      })
      .catch((e) => {
        console.warn("[content loadMore err]", String(e));
        setReachedEnd(true);
      })
      .finally(() => setLoadingMore(false));
    // optsKey drives identity; `opts` is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingMore, reachedEnd, cursor, optsKey]);

  // In-place refresh of the loaded window — re-fetch the top rows for the
  // active filters so in-flight render progress ticks without resetting the
  // cursor, selection, or scroll. Capped at 200 (loadContentPage's page-size
  // ceiling); a poll fired while more than 200 rows are loaded trims the tail,
  // a Phase-1 limitation that's acceptable because active renders sit at the
  // top of the newest-first feed.
  const refresh = useCallback(() => {
    const size = Math.min(Math.max(rows.length, PAGE_SIZE), 200);
    listContentPageAction({ ...opts, limit: size, withTotal: true })
      .then((r) => {
        setRows(r.rows);
        setCursor(r.nextCursor);
        setTotal(r.total);
        setReachedEnd(r.nextCursor === null);
      })
      .catch((e) => console.warn("[content refresh err]", String(e)));
    // optsKey drives identity; `opts` is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optsKey, rows.length]);

  return { rows, total, loading, loadingMore, reachedEnd, loadMore, refresh };
}
