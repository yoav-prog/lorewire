"use client";

// The global emergency stop for ALL unattended publishing, independent of
// autopilot and render auto-publish. One obvious control: while running it
// offers a quiet "Stop" button; once stopped it turns into a loud banner with
// a "Resume" button, so an admin can never be unsure which state they are in.
// Optimistic with rollback, matching the other scheduler toggles.

import { useState, useTransition } from "react";
import { setUnattendedPublishStopAction } from "@/app/admin/scheduler-actions";

export function UnattendedPublishStop({ initialStopped }: { initialStopped: boolean }) {
  const [stopped, setStopped] = useState(initialStopped);
  const [isPending, startTransition] = useTransition();

  function set(next: boolean) {
    if (next === stopped) return;
    const prev = stopped;
    setStopped(next);
    startTransition(async () => {
      const r = await setUnattendedPublishStopAction(next);
      if (!r.ok) setStopped(prev);
    });
  }

  if (stopped) {
    return (
      <div className="rounded-xl border border-accent bg-accent/10 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-accent" aria-hidden />
              <span className="text-[13px] font-semibold text-accent">
                Automatic publishing is stopped
              </span>
            </div>
            <p className="mt-1 text-[12px] text-muted">
              Nothing goes live on the site or to social without you. Autopilot
              and auto-publish keep their settings and pick up where they left
              off when you resume. You can still publish stories by hand.
            </p>
          </div>
          <button
            type="button"
            onClick={() => set(false)}
            disabled={isPending}
            className="shrink-0 rounded-lg border border-accent px-3 py-1.5 text-[13px] font-semibold text-accent transition-colors hover:bg-accent hover:text-bg disabled:opacity-50"
          >
            {isPending ? "Resuming…" : "Resume publishing"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-accent" aria-hidden />
            <span className="text-[13px] font-semibold text-ink">
              Automatic publishing is running
            </span>
          </div>
          <p className="mt-1 text-[12px] text-muted">
            Emergency stop for everything that publishes without a click. Use it
            if something is going out that should not. It does not change your
            autopilot or auto-publish settings.
          </p>
        </div>
        <button
          type="button"
          onClick={() => set(true)}
          disabled={isPending}
          className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-[13px] text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {isPending ? "Stopping…" : "Stop all auto-publishing"}
        </button>
      </div>
    </div>
  );
}
