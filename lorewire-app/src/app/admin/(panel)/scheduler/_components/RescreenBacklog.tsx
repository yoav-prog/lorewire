"use client";

// One-click catch-up for the held backlog. When the safety check has just been
// recalibrated, the stories the old check already held stay held — this runs
// the CURRENT check over them and publishes the ones it now clears, in batches,
// so a backlog of hundreds clears without hand-picking each one. Sits above the
// "held & why" list; the list refreshes to show whatever is still held (now
// with the new check's reason) after each batch.

import { useState, useTransition } from "react";
import { rescreenHeldBacklogAction } from "@/app/admin/scheduler-actions";

export function RescreenBacklog({ backlog }: { backlog: number }) {
  const [remaining, setRemaining] = useState(backlog);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Nothing held and nothing run yet: the list's own empty state covers it.
  if (remaining <= 0 && summary === null) return null;

  function run() {
    setError(null);
    startTransition(async () => {
      const r = await rescreenHeldBacklogAction();
      if (!r.ok) {
        setError(r.error ?? "Re-screen failed.");
        return;
      }
      setRemaining(r.remaining ?? 0);
      const parts = [
        `Published ${r.published ?? 0}`,
        `still held ${r.stillHeld ?? 0}`,
      ];
      if (r.deferred) parts.push(`waiting on assets ${r.deferred}`);
      if (r.failed) parts.push(`failed ${r.failed}`);
      setSummary(parts.join(" · "));
    });
  }

  const done = remaining <= 0;

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[14px] text-ink">
            Re-screen the backlog with the current check
          </p>
          <p className="mt-0.5 text-[12px] text-muted">
            {done
              ? "Every held story has been re-screened with the current check."
              : `Runs the current safety check over the ${remaining} held ${
                  remaining === 1 ? "story" : "stories"
                } and publishes the ones it now clears. Goes a batch at a time — click again to keep going.`}
          </p>
        </div>
        {!done && (
          <button
            type="button"
            onClick={run}
            disabled={isPending}
            className="shrink-0 rounded-lg border border-accent bg-accent/10 px-3 py-1.5 text-[13px] text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
          >
            {isPending ? "Re-screening…" : "Re-screen backlog"}
          </button>
        )}
      </div>
      {summary && (
        <p className="mt-2 text-[12px] text-muted">
          {summary}.{" "}
          {done ? "Backlog cleared." : `${remaining} left.`}
        </p>
      )}
      {error && <p className="mt-2 text-[12px] text-accent">{error}</p>}
    </div>
  );
}
