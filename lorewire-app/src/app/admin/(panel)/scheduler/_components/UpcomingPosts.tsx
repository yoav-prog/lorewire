"use client";

// The posting queue: every social post still waiting to fire, soonest
// first, each with a Cancel. Rows the dispatcher already claimed refuse
// to cancel and say so inline.

import { useState, useTransition } from "react";
import { schedulerCancelPublishAction } from "@/app/admin/scheduler-actions";

export interface UpcomingPostItem {
  id: string;
  storyId: string;
  title: string;
  platformLabel: string;
  whenLabel: string;
}

export function UpcomingPosts({ items }: { items: UpcomingPostItem[] }) {
  const [gone, setGone] = useState<Set<string>>(new Set());
  const visible = items.filter((i) => !gone.has(i.id));

  if (visible.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line bg-surface p-6 text-center text-[13px] text-muted">
        Nothing queued. Approving a story fills this list.
      </div>
    );
  }

  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {visible.map((item) => (
        <QueueRow
          key={item.id}
          item={item}
          onCancelled={() => setGone(new Set([...gone, item.id]))}
        />
      ))}
    </ul>
  );
}

function QueueRow({
  item,
  onCancelled,
}: {
  item: UpcomingPostItem;
  onCancelled: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function cancel() {
    startTransition(async () => {
      const r = await schedulerCancelPublishAction(item.id);
      if (r.ok) onCancelled();
      else setError(r.error ?? "could not cancel");
    });
  }

  return (
    <li className="flex items-center justify-between gap-4 p-4">
      <div className="min-w-0">
        <a
          href={`/admin/shorts/${item.storyId}`}
          className="block truncate text-[14px] text-ink hover:text-accent"
        >
          {item.title}
        </a>
        <p className="mt-0.5 font-mono text-[11px] uppercase tracking-wider text-muted">
          {item.platformLabel} · {item.whenLabel}
        </p>
        {error && <p className="mt-1 text-[12px] text-accent">{error}</p>}
      </div>
      <button
        type="button"
        onClick={cancel}
        disabled={isPending}
        className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-[13px] text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
      >
        {isPending ? "Cancelling…" : "Cancel"}
      </button>
    </li>
  );
}
