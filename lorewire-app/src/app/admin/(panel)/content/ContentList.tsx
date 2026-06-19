"use client";

// Client island for the /admin/content list. Owns:
//   - selection state (multi-row checkboxes + a header "select all" toggle)
//   - a sticky bulk action bar that appears when >=1 row is ticked
//   - a per-row hover ⋯ menu with the same actions, scoped to one row
//   - the shared confirm modal (typed DELETE for destructive ops)
//   - a transient inline undo banner for reversible bulk ops
//
// The list rendering itself replaces the inline `rows.map(<Link>)` block that
// used to live in page.tsx — the rest of the page (heading, filter chips,
// "New article" button) stays a server component.
//
// Plan: _plans/2026-06-19-content-bulk-actions.md.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  bulkUpdateContentAction,
  bulkDeleteContentAction,
  type BulkActionResult,
  type BulkContentItem,
  type BulkUpdateOp,
} from "@/app/admin/actions";
import {
  ARTICLE_LANGUAGE_LABELS,
  ARTICLE_TYPE_LABELS,
  articleDirection,
} from "@/lib/articles";
import type { ContentRow, ContentSubKind } from "@/lib/repo";
import { CATEGORIES, STATUSES, statusClass } from "@/app/admin/ui";
import { matchesContentSearch } from "@/lib/content-search";

const SUBKIND_LABELS: Record<ContentSubKind, string> = {
  video: "Video story",
  news: ARTICLE_TYPE_LABELS.news,
  feature: ARTICLE_TYPE_LABELS.feature,
  listicle: ARTICLE_TYPE_LABELS.listicle,
  review: ARTICLE_TYPE_LABELS.review,
};

// Articles only support the 4-step lifecycle; the pipeline-only statuses
// (scripted/rendering/ready) are story-exclusive. Filtering at the UI level
// keeps the bulk bar and the row menu from offering an option that the
// server would reject with `invalid-status-for-article`.
const ARTICLE_STATUSES = ["draft", "review", "published", "archived"] as const;

function statusesFor(kinds: { stories: number; articles: number }): readonly string[] {
  if (kinds.articles === 0) return STATUSES;
  if (kinds.stories === 0) return ARTICLE_STATUSES;
  return ARTICLE_STATUSES;
}

const UNDO_TIMEOUT_MS = 10_000;

type Kind = "story" | "article";

interface UndoState {
  op: BulkUpdateOp;
  prev: Record<string, string | null>;
}

interface ConfirmState {
  verb: string;
  items: BulkContentItem[];
  op: BulkUpdateOp | { type: "delete" };
  destructive: boolean;
}

function rowKey(kind: Kind, id: string): string {
  return `${kind}:${id}`;
}

function rowHref(row: ContentRow): string {
  return row.kind === "story"
    ? `/admin/stories/${row.id}`
    : `/admin/articles/${row.id}`;
}

function describeReason(reason: string): string {
  if (reason.startsWith("alt-missing-")) {
    const n = reason.slice("alt-missing-".length);
    return `${n} images missing alt text`;
  }
  switch (reason) {
    case "not-found":
      return "row not found (already removed?)";
    case "kind-mismatch-category":
      return "category only applies to video stories";
    case "invalid-status-for-story":
      return "this status is not valid for a video story";
    case "invalid-status-for-article":
      return "this status is not valid for an article";
    default:
      return reason;
  }
}

export function ContentList({ rows }: { rows: ContentRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [typedConfirm, setTypedConfirm] = useState("");
  const [failures, setFailures] = useState<
    { kind: Kind; id: string; reason: string }[]
  >([]);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [query, setQuery] = useState("");

  // Cancel any pending undo timer when the component unmounts so a navigation
  // away doesn't leak a stale setState.
  useEffect(() => {
    return () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    };
  }, []);

  const rowByKey = useMemo(() => {
    const m = new Map<string, ContentRow>();
    for (const r of rows) m.set(rowKey(r.kind, r.id), r);
    return m;
  }, [rows]);

  // The search bar narrows the visible row set in place. The full `rows`
  // array still drives rowByKey so a row that's selected and then hidden
  // by the query stays in `selected` — clearing the query restores it.
  const filteredRows = useMemo(() => {
    if (!query.trim()) return rows;
    return rows.filter((r) => matchesContentSearch(r, query));
  }, [rows, query]);

  const filteredKeySet = useMemo(() => {
    const s = new Set<string>();
    for (const r of filteredRows) s.add(rowKey(r.kind, r.id));
    return s;
  }, [filteredRows]);

  // selectedItems is the source of truth for "what's actually actionable".
  // Stale keys (selected rows that vanished after a filter change or a
  // delete) silently drop out here rather than being explicitly cleared,
  // which both avoids the setState-in-effect anti-pattern and preserves
  // selection across filter changes — handy when the operator filters,
  // ticks, switches filter, and comes back.
  const selectedItems: BulkContentItem[] = useMemo(() => {
    const items: BulkContentItem[] = [];
    for (const key of selected) {
      const r = rowByKey.get(key);
      if (r) items.push({ kind: r.kind, id: r.id });
    }
    return items;
  }, [selected, rowByKey]);

  const counts = useMemo(() => {
    let stories = 0;
    let articles = 0;
    for (const item of selectedItems) {
      if (item.kind === "story") stories += 1;
      else articles += 1;
    }
    return { stories, articles, total: selectedItems.length };
  }, [selectedItems]);

  const anySelected = counts.total > 0;
  // Header checkbox tracks the *visible* set (rows after the search filter).
  // This matches the lazy-user expectation: type to narrow, click select-all,
  // get exactly the rows you can see.
  const allFilteredSelected = useMemo(() => {
    if (filteredRows.length === 0) return false;
    for (const key of filteredKeySet) {
      if (!selected.has(key)) return false;
    }
    return true;
  }, [filteredRows, filteredKeySet, selected]);

  function toggleOne(kind: Kind, id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = rowKey(kind, id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      console.info("[content list selection]", { count: next.size });
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        // Deselect the visible set; rows hidden by the search query stay
        // selected so they are not silently dropped.
        for (const key of filteredKeySet) next.delete(key);
      } else {
        for (const key of filteredKeySet) next.add(key);
      }
      console.info("[content list selection]", { count: next.size });
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  // Open the confirm modal with the chosen action. Per-row actions reuse this
  // by passing a one-item array, so there's exactly one execution path.
  function requestAction(
    items: BulkContentItem[],
    op: BulkUpdateOp | { type: "delete" },
  ) {
    if (items.length === 0) return;
    setTypedConfirm("");
    setFailures([]);
    const verb =
      op.type === "delete"
        ? "Delete"
        : op.type === "status"
          ? op.status === "published"
            ? "Publish"
            : op.status === "draft"
              ? "Unpublish"
              : `Set status to "${op.status}"`
          : `Set category to "${op.category}"`;
    setConfirm({ verb, items, op, destructive: op.type === "delete" });
  }

  function clearUndo() {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = null;
    setUndo(null);
  }

  function scheduleUndo(op: BulkUpdateOp, prev: Record<string, string | null>) {
    if (Object.keys(prev).length === 0) return;
    setUndo({ op, prev });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_TIMEOUT_MS);
  }

  function runUndo() {
    if (!undo) return;
    const reversals = new Map<string, BulkContentItem[]>();
    for (const [key, prevValue] of Object.entries(undo.prev)) {
      if (prevValue == null) continue;
      const [kind, id] = key.split(":") as [Kind, string];
      const bucket = reversals.get(prevValue) ?? [];
      bucket.push({ kind, id });
      reversals.set(prevValue, bucket);
    }
    if (reversals.size === 0) {
      clearUndo();
      return;
    }
    console.info("[content list undo]", {
      type: undo.op.type,
      count: Object.keys(undo.prev).length,
    });
    const opType = undo.op.type;
    startTransition(async () => {
      for (const [value, items] of reversals.entries()) {
        const op: BulkUpdateOp =
          opType === "status"
            ? { type: "status", status: value }
            : { type: "category", category: value };
        try {
          await bulkUpdateContentAction(items, op);
        } catch (err) {
          console.error("[content list undo failed]", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      clearUndo();
      router.refresh();
    });
  }

  function runConfirmed() {
    if (!confirm) return;
    const { items, op } = confirm;
    console.info("[content list bulk submit]", {
      type: op.type,
      count: items.length,
    });
    startTransition(async () => {
      let result: BulkActionResult;
      try {
        if (op.type === "delete") {
          result = await bulkDeleteContentAction(items);
        } else {
          result = await bulkUpdateContentAction(items, op);
        }
      } catch (err) {
        setFailures([
          {
            kind: items[0].kind,
            id: items[0].id,
            reason: err instanceof Error ? err.message : String(err),
          },
        ]);
        setConfirm(null);
        return;
      }
      setFailures(result.failed);
      setConfirm(null);
      if (op.type !== "delete" && result.ok.length > 0) {
        scheduleUndo(op, result.prev);
      }
      clearSelection();
      router.refresh();
    });
  }

  // --- render ---------------------------------------------------------------

  return (
    <>
      {undo && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent/10 px-4 py-2 font-mono text-[11px] text-ink">
          <span>
            Applied to {Object.keys(undo.prev).length}{" "}
            {Object.keys(undo.prev).length === 1 ? "item" : "items"}.
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={runUndo}
              disabled={pending}
              className="rounded-md border border-accent px-2 py-0.5 text-accent transition-colors hover:bg-accent hover:text-bg disabled:cursor-not-allowed disabled:opacity-40"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={clearUndo}
              className="text-muted transition-colors hover:text-ink"
              aria-label="Dismiss"
            >
              ×
            </button>
          </span>
        </div>
      )}

      {failures.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-danger/40 bg-danger/10 p-3 font-mono text-[11px] text-danger">
          {failures.map((f, i) => {
            const r = rowByKey.get(rowKey(f.kind, f.id));
            const label = r?.title ?? r?.slug ?? f.id.slice(0, 8);
            return (
              <li key={i}>
                <span className="text-ink">{label}</span>
                <span className="opacity-70"> — {describeReason(f.reason)}</span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="relative">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title, slug, category, status, id…"
          aria-label="Search content"
          className="w-full rounded-xl border border-line bg-surface px-4 py-2 pr-9 text-[13px] text-ink placeholder:text-muted focus:border-accent focus:outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-0.5 font-mono text-[12px] text-muted transition-colors hover:text-ink"
          >
            ×
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        {rows.length === 0 ? (
          <p className="bg-surface p-6 text-center text-[14px] text-muted">
            No content matches this filter.
          </p>
        ) : filteredRows.length === 0 ? (
          <p className="bg-surface p-6 text-center text-[14px] text-muted">
            No content matches{" "}
            <span className="font-mono text-ink">&ldquo;{query.trim()}&rdquo;</span>
            .
          </p>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-line bg-surface2 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-muted">
              <input
                type="checkbox"
                checked={allFilteredSelected}
                onChange={toggleAll}
                aria-label={
                  allFilteredSelected ? "Clear selection" : "Select all"
                }
                className="h-3.5 w-3.5 cursor-pointer accent-accent"
              />
              <span>
                {anySelected
                  ? `${counts.total} selected`
                  : query.trim()
                    ? `${filteredRows.length} of ${rows.length} ${rows.length === 1 ? "item" : "items"}`
                    : `${rows.length} ${rows.length === 1 ? "item" : "items"}`}
              </span>
            </div>
            {filteredRows.map((r) => {
              const key = rowKey(r.kind, r.id);
              const isSelected = selected.has(key);
              return (
                <div
                  key={key}
                  className={`group flex items-stretch border-b border-line last:border-0 ${
                    isSelected ? "bg-surface2" : "bg-surface hover:bg-surface2"
                  }`}
                >
                  <label className="flex shrink-0 cursor-pointer items-center pl-4 pr-2">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(r.kind, r.id)}
                      aria-label={`Select ${r.title ?? r.slug ?? r.id}`}
                      className="h-3.5 w-3.5 cursor-pointer accent-accent"
                    />
                  </label>
                  <Link
                    href={rowHref(r)}
                    className="flex min-w-0 flex-1 items-center justify-between gap-3 py-3 pr-3"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span
                        className={`shrink-0 rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                          r.kind === "story"
                            ? "border-cat-entitled/40 bg-cat-entitled/15 text-cat-entitled"
                            : "border-accent/40 bg-accent/15 text-accent"
                        }`}
                      >
                        {SUBKIND_LABELS[r.subKind]}
                      </span>
                      <span className="min-w-0">
                        <span
                          dir={articleDirection(r.language)}
                          className="block truncate text-[14px] text-ink"
                        >
                          {r.title || r.slug || r.id.slice(0, 8)}
                        </span>
                        <span className="font-mono text-[11px] text-muted">
                          {r.badge ?? "—"}
                          {r.language
                            ? ` · ${ARTICLE_LANGUAGE_LABELS[r.language as keyof typeof ARTICLE_LANGUAGE_LABELS] ?? r.language}`
                            : ""}
                          {r.updated_at ? ` · ${r.updated_at.slice(0, 10)}` : ""}
                        </span>
                      </span>
                    </span>
                    <span
                      className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${statusClass(
                        r.status,
                      )}`}
                    >
                      {r.status ?? "draft"}
                    </span>
                  </Link>
                  <RowMenu
                    row={r}
                    disabled={pending}
                    onAction={(op) =>
                      requestAction([{ kind: r.kind, id: r.id }], op)
                    }
                  />
                </div>
              );
            })}
          </>
        )}
      </div>

      {anySelected && (
        <BulkActionBar
          counts={counts}
          disabled={pending}
          onAction={(op) => requestAction(selectedItems, op)}
          onClear={clearSelection}
        />
      )}

      {confirm && (
        <ConfirmModal
          state={confirm}
          rowByKey={rowByKey}
          typedConfirm={typedConfirm}
          onTypedConfirmChange={setTypedConfirm}
          pending={pending}
          onCancel={() => setConfirm(null)}
          onRun={runConfirmed}
        />
      )}
    </>
  );
}

// --- Bulk action bar (sticky bottom) ----------------------------------------

function BulkActionBar({
  counts,
  disabled,
  onAction,
  onClear,
}: {
  counts: { total: number; stories: number; articles: number };
  disabled: boolean;
  onAction: (op: BulkUpdateOp | { type: "delete" }) => void;
  onClear: () => void;
}) {
  const categoryDisabled = counts.articles > 0;
  return (
    <div className="sticky bottom-4 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface2 px-4 py-3 shadow-2xl">
      <span className="font-mono text-[11px] uppercase tracking-wider text-ink">
        {counts.total} selected
        <span className="ml-2 text-muted">
          ({counts.stories} stories · {counts.articles} articles)
        </span>
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <BarButton
          label="Publish"
          disabled={disabled}
          onClick={() => onAction({ type: "status", status: "published" })}
        />
        <BarButton
          label="Unpublish"
          disabled={disabled}
          onClick={() => onAction({ type: "status", status: "draft" })}
        />
        <Picker
          label="Status ▾"
          disabled={disabled}
          options={statusesFor(counts).map((s) => ({ value: s, label: s }))}
          onPick={(value) => onAction({ type: "status", status: value })}
        />
        <Picker
          label="Category ▾"
          disabled={disabled || categoryDisabled}
          disabledHint={
            categoryDisabled ? "Category applies to video stories only" : null
          }
          options={CATEGORIES.map((c) => ({ value: c, label: c }))}
          onPick={(value) => onAction({ type: "category", category: value })}
        />
        <BarButton
          label="Delete"
          danger
          disabled={disabled}
          onClick={() => onAction({ type: "delete" })}
        />
        <button
          type="button"
          onClick={onClear}
          disabled={disabled}
          className="rounded-md border border-line px-2 py-1 font-mono text-[11px] text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

function BarButton({
  label,
  danger,
  disabled,
  onClick,
}: {
  label: string;
  danger?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? "border-danger/50 text-danger hover:bg-danger hover:text-bg"
          : "border-line text-ink hover:border-accent hover:text-accent"
      }`}
    >
      {label}
    </button>
  );
}

// --- Inline pickers (status / category) -------------------------------------

function Picker({
  label,
  options,
  onPick,
  disabled,
  disabledHint,
}: {
  label: string;
  options: { value: string; label: string }[];
  onPick: (value: string) => void;
  disabled: boolean;
  disabledHint?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title={disabled && disabledHint ? disabledHint : undefined}
        className="rounded-md border border-line px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        {label}
      </button>
      {open && (
        <ul className="absolute right-0 z-20 mt-1 min-w-[140px] overflow-hidden rounded-md border border-line bg-surface shadow-2xl">
          {options.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick(o.value);
                }}
                className="block w-full px-3 py-1.5 text-left font-mono text-[11px] text-ink transition-colors hover:bg-surface2"
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Per-row hover menu -----------------------------------------------------

function RowMenu({
  row,
  disabled,
  onAction,
}: {
  row: ContentRow;
  disabled: boolean;
  onAction: (op: BulkUpdateOp | { type: "delete" }) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isStory = row.kind === "story";
  const isPublished = row.status === "published";

  return (
    <div ref={wrap} className="relative flex shrink-0 items-center pr-3">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-label="Row actions"
        className="rounded-md border border-transparent px-2 py-1 font-mono text-[12px] text-muted opacity-0 transition-opacity hover:border-line hover:text-ink group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-20"
      >
        ⋯
      </button>
      {open && (
        <ul className="absolute right-3 top-full z-20 mt-1 min-w-[180px] overflow-hidden rounded-md border border-line bg-surface shadow-2xl">
          <RowMenuItem
            label={isPublished ? "Unpublish" : "Publish"}
            onClick={() => {
              setOpen(false);
              onAction({
                type: "status",
                status: isPublished ? "draft" : "published",
              });
            }}
          />
          <RowMenuPicker
            label="Set status →"
            options={(isStory ? STATUSES : ARTICLE_STATUSES).map((s) => ({
              value: s,
              label: s,
            }))}
            onPick={(value) => {
              setOpen(false);
              onAction({ type: "status", status: value });
            }}
          />
          {isStory && (
            <RowMenuPicker
              label="Set category →"
              options={CATEGORIES.map((c) => ({ value: c, label: c }))}
              onPick={(value) => {
                setOpen(false);
                onAction({ type: "category", category: value });
              }}
            />
          )}
          <li className="border-t border-line">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onAction({ type: "delete" });
              }}
              className="block w-full px-3 py-1.5 text-left font-mono text-[11px] text-danger transition-colors hover:bg-danger hover:text-bg"
            >
              Delete
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

function RowMenuItem({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="block w-full px-3 py-1.5 text-left font-mono text-[11px] text-ink transition-colors hover:bg-surface2"
      >
        {label}
      </button>
    </li>
  );
}

function RowMenuPicker({
  label,
  options,
  onPick,
}: {
  label: string;
  options: { value: string; label: string }[];
  onPick: (value: string) => void;
}) {
  return (
    <li className="border-t border-line">
      <div className="px-3 pt-1.5 pb-0.5 font-mono text-[9px] uppercase tracking-wider text-muted">
        {label}
      </div>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onPick(o.value)}
          className="block w-full px-3 py-1 text-left font-mono text-[11px] text-ink transition-colors hover:bg-surface2"
        >
          {o.label}
        </button>
      ))}
    </li>
  );
}

// --- Confirm modal ----------------------------------------------------------

function ConfirmModal({
  state,
  rowByKey,
  typedConfirm,
  onTypedConfirmChange,
  pending,
  onCancel,
  onRun,
}: {
  state: ConfirmState;
  rowByKey: Map<string, ContentRow>;
  typedConfirm: string;
  onTypedConfirmChange: (v: string) => void;
  pending: boolean;
  onCancel: () => void;
  onRun: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, onCancel]);

  let stories = 0;
  let articles = 0;
  for (const item of state.items) {
    if (item.kind === "story") stories += 1;
    else articles += 1;
  }
  const previewCount = Math.min(state.items.length, 6);
  const overflow = state.items.length - previewCount;
  const destructive = state.destructive;
  const confirmDisabled = pending || (destructive && typedConfirm !== "DELETE");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-confirm-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-6"
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-2xl">
        <h3
          id="bulk-confirm-title"
          className="font-display text-[16px] font-bold text-ink"
        >
          {state.verb} {state.items.length}{" "}
          {state.items.length === 1 ? "item" : "items"}?
        </h3>
        <p className="mt-1 font-mono text-[11px] text-muted">
          {stories} {stories === 1 ? "story" : "stories"} · {articles}{" "}
          {articles === 1 ? "article" : "articles"}
        </p>
        <ul className="mt-3 max-h-48 space-y-1 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-[11px] text-muted">
          {state.items.slice(0, previewCount).map((it) => {
            const r = rowByKey.get(rowKey(it.kind, it.id));
            const label = r?.title ?? r?.slug ?? it.id.slice(0, 8);
            return (
              <li key={`${it.kind}:${it.id}`} className="truncate text-ink">
                {label}
              </li>
            );
          })}
          {overflow > 0 && (
            <li className="text-muted">
              …and {overflow} {overflow === 1 ? "more" : "more"}
            </li>
          )}
        </ul>
        {destructive && (
          <div className="mt-3 space-y-2">
            <p className="font-mono text-[11px] text-danger">
              Hard delete is permanent. Rendered audio and video are also
              removed from storage. Type DELETE to confirm.
            </p>
            <input
              type="text"
              value={typedConfirm}
              onChange={(e) =>
                onTypedConfirmChange(e.target.value.toUpperCase())
              }
              placeholder="DELETE"
              autoFocus
              className="w-full rounded-md border border-danger/50 bg-bg px-3 py-2 font-mono text-[12px] text-ink placeholder:text-muted focus:border-danger focus:outline-none"
            />
          </div>
        )}
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onRun}
            disabled={confirmDisabled}
            className={`flex-1 rounded-md px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${
              destructive
                ? "bg-danger text-bg hover:opacity-90"
                : "bg-accent text-bg hover:opacity-90"
            }`}
          >
            {pending ? "Working…" : state.verb}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
