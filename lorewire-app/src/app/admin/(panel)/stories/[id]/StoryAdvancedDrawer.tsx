// Collapsed-by-default container for rail cards that don't belong to the
// active tab's primary slot. Lives at the bottom of every per-tab rail —
// the per-tab StoryRail decides which cards land in the primary section
// vs this drawer.
//
// Native <details> + <summary> on purpose: zero JS, accessible by
// default, keyboard-toggleable, screen-reader-friendly, and the only
// state lives in the DOM. If we ever want smooth open/close animation
// or persisted expand state, swap to a client component later.
//
// Plan: _plans/2026-06-25-story-action-bar-and-rail-restructure.md.

import type { ReactNode } from "react";

export function StoryAdvancedDrawer({
  children,
  label = "Advanced settings",
  hint,
}: {
  children: ReactNode;
  /** Override the default label when the drawer's contents are obviously
   *  scoped to one concept (e.g. "Pipeline overrides"). */
  label?: string;
  /** One-line subtext under the trigger to telegraph what's inside. */
  hint?: string;
}) {
  return (
    <details className="group rounded-xl border border-dashed border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 transition-colors hover:bg-surface2">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-wider text-muted">
            {label}
          </div>
          {hint && (
            <div className="mt-0.5 text-[11px] text-muted/80">{hint}</div>
          )}
        </div>
        <span
          aria-hidden
          className="font-mono text-[14px] text-muted transition-transform group-open:rotate-90"
        >
          ▸
        </span>
      </summary>
      <div className="space-y-4 border-t border-dashed border-line p-4">
        {children}
      </div>
    </details>
  );
}
