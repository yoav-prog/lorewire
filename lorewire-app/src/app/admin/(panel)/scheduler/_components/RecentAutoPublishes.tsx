"use client";

// The stories autopilot published, newest first, each with Retract — the
// recall path when something went out that should not have. Retract is
// destructive (unpublishes the site article and deletes social posts),
// so it takes a second click to confirm and then reports what happened
// on every platform, including TikTok's manual-removal caveat.

import { useState, useTransition } from "react";
import { schedulerRetractStoryAction } from "@/app/admin/scheduler-actions";

export interface RecentAutoPublishItem {
  storyId: string;
  title: string;
  status: string;
  whenLabel: string;
}

const OUTCOME_LABELS: Record<string, string> = {
  deleted: "deleted",
  manual_delete_needed: "delete by hand in the app",
  nothing_posted: "nothing was posted",
  failed: "delete FAILED",
};

export function RecentAutoPublishes({ items }: { items: RecentAutoPublishItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-[12px] text-muted">
        Nothing published by autopilot yet. Everything it publishes will be
        listed here with a Retract button.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {items.map((item) => (
        <Row key={item.storyId} item={item} />
      ))}
    </ul>
  );
}

function Row({ item }: { item: RecentAutoPublishItem }) {
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [retracted, setRetracted] = useState(item.status === "archived");
  const [isPending, startTransition] = useTransition();

  function retract() {
    setConfirming(false);
    startTransition(async () => {
      const r = await schedulerRetractStoryAction(item.storyId);
      if (!r.ok) {
        setOutcome(r.error ?? "retract failed");
        return;
      }
      setRetracted(true);
      const parts = r.platforms
        .filter((p) => p.status !== "nothing_posted")
        .map((p) => `${p.platform}: ${OUTCOME_LABELS[p.status] ?? p.status}`);
      setOutcome(
        [
          "Off the site.",
          r.cancelledQueued > 0 ? `${r.cancelledQueued} queued post(s) cancelled.` : null,
          parts.length > 0 ? parts.join(" · ") : "No social posts had gone out.",
        ]
          .filter(Boolean)
          .join(" "),
      );
    });
  }

  return (
    <li className="p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <a
            href={`/admin/shorts/${item.storyId}`}
            className="block truncate text-[14px] text-ink hover:text-accent"
          >
            {item.title}
          </a>
          <p className="mt-0.5 font-mono text-[11px] uppercase tracking-wider text-muted">
            {retracted ? "retracted" : item.status} · {item.whenLabel}
          </p>
        </div>
        {!retracted && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={isPending}
            className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-[13px] text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {isPending ? "Retracting…" : "Retract"}
          </button>
        )}
        {!retracted && confirming && (
          <span className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={retract}
              className="rounded-lg border border-accent px-3 py-1.5 text-[13px] text-accent transition-colors hover:bg-accent hover:text-bg"
            >
              Yes, take it down everywhere
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-muted hover:text-ink"
            >
              Keep it
            </button>
          </span>
        )}
      </div>
      {confirming && (
        <p className="mt-2 text-[12px] text-muted">
          Removes the article from the site, cancels queued posts, and deletes
          the YouTube, Facebook, and Instagram posts. A TikTok post can only be
          removed in the TikTok app.
        </p>
      )}
      {outcome && <p className="mt-2 text-[12px] text-accent">{outcome}</p>}
    </li>
  );
}
