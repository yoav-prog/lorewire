"use client";

// Site-wide comments on/off. Optimistic toggle around the co-located server
// action; reverts on failure. The big-red-button for when a thread (or the
// whole site) goes bad.

import { useState, useTransition } from "react";
import { setSiteCommentsEnabledAction } from "./actions";

export function CommentsKillSwitch({ enabled }: { enabled: boolean }) {
  const [on, setOn] = useState(enabled);
  const [pending, start] = useTransition();

  function toggle(): void {
    const next = !on;
    setOn(next);
    start(async () => {
      try {
        await setSiteCommentsEnabledAction(next);
      } catch {
        setOn(!next);
      }
    });
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-ink">Comments, site-wide</p>
        <p className="mt-1 text-[12px] text-muted">
          {on
            ? "Readers can comment on published articles."
            : "Commenting is off across the whole site. Existing comments stay visible."}
        </p>
      </div>
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-pressed={on}
        className={`rounded-md border px-4 py-1.5 text-[13px] font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${
          on
            ? "border-cat-wholesome/40 bg-cat-wholesome/15 text-cat-wholesome"
            : "border-cat-entitled/40 bg-cat-entitled/15 text-cat-entitled"
        }`}
      >
        {on ? "On" : "Off"}
      </button>
    </div>
  );
}
