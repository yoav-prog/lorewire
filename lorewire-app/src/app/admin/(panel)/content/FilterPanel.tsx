"use client";

// Collapsible wrapper for the /admin/content filter rows. The rows
// themselves stay server-rendered (they're plain <Link> chips built from
// searchParams); this island only owns the open/closed state so the ten
// filter dimensions don't dominate the page. Collapsed, the header still
// shows every ACTIVE filter as a removable chip, so nothing the operator
// applied ever goes invisible.
//
// State survives chip-click navigations because the island keeps its
// position in the tree across searchParam-only re-renders.
//
// Plan: _plans/2026-07-02-content-admin-cleanup-and-full-pipeline.md.

import Link from "next/link";
import { useState, type ReactNode } from "react";

export interface ActiveFilterChip {
  /** Filter dimension, e.g. "Status". */
  key: string;
  /** Applied value, e.g. "published". */
  label: string;
  /** URL with this one filter cleared and the rest preserved. */
  clearHref: string;
}

export function FilterPanel({
  active,
  clearAllHref,
  children,
}: {
  active: ActiveFilterChip[];
  clearAllHref: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <button
          type="button"
          onClick={() => {
            setOpen((v) => {
              console.info("[content filters] toggle", { open: !v });
              return !v;
            });
          }}
          aria-expanded={open}
          className="flex items-center gap-2 rounded-md border border-line px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent"
        >
          <span aria-hidden className="text-[9px]">
            {open ? "▲" : "▼"}
          </span>
          Filters
          {active.length > 0 && (
            <span className="rounded-full bg-accent px-1.5 py-px font-mono text-[10px] font-bold text-bg">
              {active.length}
            </span>
          )}
        </button>
        {active.length === 0 ? (
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Showing everything
          </span>
        ) : (
          <>
            {active.map((f) => (
              <Link
                key={`${f.key}:${f.label}`}
                href={f.clearHref}
                title={`Remove the ${f.key} filter`}
                className="group flex items-center gap-1.5 rounded-full border border-ink/30 bg-surface2 px-3 py-1 font-mono text-[11px] text-ink transition-colors hover:border-danger/50 hover:text-danger"
              >
                <span className="uppercase tracking-wider text-muted group-hover:text-danger/70">
                  {f.key}
                </span>
                {f.label}
                <span aria-hidden>×</span>
              </Link>
            ))}
            <Link
              href={clearAllHref}
              className="font-mono text-[10px] uppercase tracking-wider text-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
            >
              Clear all
            </Link>
          </>
        )}
      </div>
      {open && (
        <div className="space-y-2 border-t border-line px-4 py-3">
          {children}
        </div>
      )}
    </div>
  );
}
