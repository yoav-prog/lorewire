"use client";

// Category filter for the Wires feed (mobile + desktop). A single funnel button
// with an active-count badge opens a multi-select panel of the granular
// categories; picking any restricts the feed to wires tagged with those
// categories (server-filtered on story_tags). Kept behind a button — not a
// persistent chip row — so the video frame stays clean.
//
// mobile → a bottom sheet; desktop → a popover anchored under the button. The
// selection is live (each chip toggles immediately and the feed refetches
// behind the panel); "Done" / an outside tap / Escape closes it.

import { useEffect, useState } from "react";
import { GRANULAR_CATEGORIES } from "@/lib/categories/granular";

const FunnelIcon = ({
  size = 18,
  active = false,
}: {
  size?: number;
  active?: boolean;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={active ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 5h18l-7 8v5l-4 2v-7L3 5Z" />
  </svg>
);

export interface WireCategoryFilterProps {
  /** Selected granular category slugs. */
  selected: string[];
  onToggle: (slug: string) => void;
  onClear: () => void;
  variant?: "mobile" | "desktop";
}

export function WireCategoryFilter({
  selected,
  onToggle,
  onClear,
  variant = "mobile",
}: WireCategoryFilterProps) {
  const [open, setOpen] = useState(false);
  const count = selected.length;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const panelClass =
    variant === "mobile"
      ? "fixed inset-x-0 bottom-0 z-[61] max-h-[72vh] overflow-y-auto rounded-t-3xl border-t border-line bg-[#0e0e10] px-4 pt-4"
      : "absolute right-0 top-full z-[61] mt-2 max-h-[72vh] w-80 overflow-y-auto rounded-2xl border border-line bg-[#0e0e10] p-4 shadow-2xl";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-label="Filter by category"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink"
        style={{ background: "rgba(0,0,0,.5)", opacity: count > 0 || open ? 1 : 0.9 }}
      >
        <FunnelIcon size={18} active={count > 0} />
        {count > 0 && (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-[16px] place-items-center rounded-full bg-accent px-1 font-mono text-[9px] font-bold leading-none text-bg">
            {count}
          </span>
        )}
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-[60] bg-black/40"
            aria-hidden
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          />
          <div
            role="dialog"
            aria-label="Filter wires by category"
            onClick={(e) => e.stopPropagation()}
            className={panelClass}
            style={
              variant === "mobile"
                ? { paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)" }
                : undefined
            }
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-[15px] font-black uppercase tracking-tight text-ink">
                Categories
              </h3>
              {count > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClear();
                  }}
                  className="font-mono text-[11px] uppercase tracking-[.16em] text-muted transition-colors hover:text-ink"
                >
                  Clear
                </button>
              )}
            </div>
            <p className="mt-1 font-body text-[12px] text-muted">
              Show only wires in the categories you pick.
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              {GRANULAR_CATEGORIES.map((c) => {
                const active = selected.includes(c.slug);
                return (
                  <button
                    key={c.slug}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggle(c.slug);
                    }}
                    aria-pressed={active}
                    data-slug={c.slug}
                    className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[.14em] transition-colors"
                    style={
                      active
                        ? { background: c.color, borderColor: c.color, color: "#fff" }
                        : {
                            borderColor: "var(--color-line)",
                            color: "var(--color-muted)",
                          }
                    }
                  >
                    <span aria-hidden className="opacity-80">
                      {c.glyph}
                    </span>
                    {c.label}
                  </button>
                );
              })}
            </div>

            {variant === "mobile" && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                }}
                className="mt-4 w-full rounded-full bg-accent py-2.5 font-mono text-[12px] font-bold uppercase tracking-[.18em] text-bg transition active:scale-[.99]"
              >
                Done
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
