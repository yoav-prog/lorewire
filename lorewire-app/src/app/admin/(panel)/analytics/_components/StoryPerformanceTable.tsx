"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { StoryPerformanceRow } from "@/lib/analytics-shared";
import { formatCompact, formatPercent } from "@/lib/chart-math";
import { statusClass } from "@/app/admin/ui";

// The searchable heart of the dashboard: every public story (plus any
// story with events in the window) with its engagement rollup. Search,
// status filter and column sorting all happen client-side over the
// server-provided rows — instant for the volumes this site has. Each
// title links to the per-story drilldown.

type SortKey =
  | "title"
  | "plays"
  | "completionRate"
  | "viewers"
  | "votes"
  | "saves"
  | "shares"
  | "score";

const COLUMNS: Array<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: "title", label: "Story", numeric: false },
  { key: "plays", label: "Plays", numeric: true },
  { key: "completionRate", label: "Compl.", numeric: true },
  { key: "viewers", label: "Viewers", numeric: true },
  { key: "votes", label: "Votes", numeric: true },
  { key: "saves", label: "Saves", numeric: true },
  { key: "shares", label: "Shares", numeric: true },
  { key: "score", label: "Score", numeric: true },
];

const RENDER_CAP = 100;

export default function StoryPerformanceTable({
  rows,
  rangeLabel,
}: {
  rows: StoryPerformanceRow[];
  rangeLabel: string;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDesc, setSortDesc] = useState(true);

  const statuses = useMemo(() => {
    const set = new Set(rows.map((r) => r.status ?? "draft"));
    return ["all", ...Array.from(set).sort()];
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = rows.filter((r) => {
      if (status !== "all" && (r.status ?? "draft") !== status) return false;
      if (!q) return true;
      return (
        r.title.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        (r.category ?? "").toLowerCase().includes(q)
      );
    });
    const dir = sortDesc ? -1 : 1;
    matched.sort((a, b) => {
      if (sortKey === "title") return dir * a.title.localeCompare(b.title);
      const av = a[sortKey] ?? -1;
      const bv = b[sortKey] ?? -1;
      return dir * (av === bv ? a.title.localeCompare(b.title) : av - bv);
    });
    return matched;
  }, [rows, query, status, sortKey, sortDesc]);

  function onSort(key: SortKey) {
    console.info("[analytics table] sort", { key, wasDesc: sortDesc });
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(key !== "title");
    }
  }

  function onSearch(value: string) {
    setQuery(value);
    console.info("[analytics table] search", { q: value });
  }

  const visible = filtered.slice(0, RENDER_CAP);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search by title, category or id"
          aria-label="Search stories"
          className="w-full max-w-xs rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] text-ink placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          {statuses.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={
                s === status
                  ? "rounded-full bg-accent px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-bg"
                  : "rounded-full border border-line px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-accent hover:text-accent"
              }
            >
              {s}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[12px] text-muted">
          {filtered.length === rows.length
            ? `${rows.length} stories`
            : `${filtered.length} of ${rows.length} stories`}
          {" · "}
          {rangeLabel}
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line bg-surface p-8 text-center">
          <p className="text-[14px] text-ink">No stories match.</p>
          <p className="mt-1 text-[13px] text-muted">
            Try a shorter search, or clear the status filter.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full border-collapse text-[13px]">
            <thead className="border-b border-line">
              <tr className="text-left">
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    className={`px-4 py-3 ${c.numeric ? "text-right" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => onSort(c.key)}
                      className={`font-mono text-[11px] uppercase tracking-wider transition-colors hover:text-accent ${
                        sortKey === c.key ? "text-ink" : "text-muted"
                      }`}
                    >
                      {c.label}
                      {sortKey === c.key ? (sortDesc ? " ↓" : " ↑") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} className="border-t border-line align-middle">
                  <td className="max-w-[320px] px-4 py-2">
                    <Link
                      href={`/admin/analytics/${r.id}`}
                      className="group flex items-center gap-3"
                    >
                      {r.thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element -- tiny admin thumb, remote R2 host
                        <img
                          src={r.thumbnail}
                          alt=""
                          className="h-12 w-8 shrink-0 rounded-md border border-line object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <span className="h-12 w-8 shrink-0 rounded-md border border-line bg-surface2" />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate text-ink group-hover:text-accent">
                          {r.title}
                        </span>
                        <span className="mt-0.5 flex items-center gap-2">
                          <span className="font-mono text-[10px] text-muted">
                            {r.category ?? "uncategorized"}
                          </span>
                          <span
                            className={`rounded-full border px-1.5 py-px font-mono text-[9px] uppercase tracking-wider ${statusClass(r.status)}`}
                          >
                            {r.status ?? "draft"}
                          </span>
                        </span>
                      </span>
                    </Link>
                  </td>
                  <Num value={formatCompact(r.plays)} />
                  <Num value={formatPercent(r.completionRate)} muted={r.completionRate === null} />
                  <Num value={formatCompact(r.viewers)} />
                  <Num value={formatCompact(r.votes)} />
                  <Num value={formatCompact(r.saves)} />
                  <Num value={formatCompact(r.shares)} />
                  <Num value={r.score.toFixed(1)} strong />
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > RENDER_CAP && (
            <p className="border-t border-line px-4 py-2 text-[12px] text-muted">
              Showing the top {RENDER_CAP} of {filtered.length} matches. Search to
              narrow down.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Num({
  value,
  muted,
  strong,
}: {
  value: string;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <td
      className={`px-4 py-2 text-right font-mono text-[12px] ${
        muted ? "text-muted" : strong ? "font-semibold text-ink" : "text-ink"
      }`}
    >
      {value}
    </td>
  );
}
