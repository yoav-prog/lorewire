"use client";

// The stories an unattended lane held for a human, each with the safety
// judge's reason so a hold is never a mystery, and a one-click "Publish
// anyway" that runs the exact same publish path as the Approve button. This
// is the surface that made the 100%-false-positive judge visible: before it,
// a hold stored no reason and looked identical to every other hold.

import { useState, useTransition } from "react";
import { schedulerApproveStoryAction } from "@/app/admin/scheduler-actions";

export interface HeldStoryItem {
  storyId: string;
  title: string;
  category: string | null;
  reason: string | null;
  confidence: number | null;
  ageLabel: string;
}

// Judge taxonomy -> plain label. Unknown/fail-closed categories fall through
// to the raw value so nothing is silently hidden.
const CATEGORY_LABELS: Record<string, string> = {
  clean: "Looked clean",
  real_person: "Names a real person",
  minors_or_self_harm: "Minors or self-harm",
  hate_or_harassment: "Hate or harassment",
  sexual: "Sexual content",
  graphic_or_shocking: "Graphic or shocking",
  platform_policy_risk: "Platform policy risk",
  not_a_story: "Not a real story",
  borderline: "Borderline",
  judge_unavailable: "Safety check unavailable",
  judge_malformed: "Safety check error",
};

function categoryLabel(category: string | null): string {
  if (!category) return "No reason recorded";
  return CATEGORY_LABELS[category] ?? category;
}

export function HeldStories({ items }: { items: HeldStoryItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-[12px] text-muted">
        Nothing is held right now. Stories the safety check holds for you will
        appear here with the reason and a one-click publish.
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

function Row({ item }: { item: HeldStoryItem }) {
  const [published, setPublished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function publishAnyway() {
    setError(null);
    startTransition(async () => {
      const r = await schedulerApproveStoryAction(item.storyId);
      if (!r.ok) {
        const missing = r.missing?.length ? ` (missing: ${r.missing.join(", ")})` : "";
        setError((r.error ?? "publish failed") + missing);
        return;
      }
      setPublished(true);
    });
  }

  const pct =
    item.confidence === null ? null : `${Math.round(item.confidence * 100)}%`;

  return (
    <li className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <a
            href={`/admin/shorts/${item.storyId}`}
            className="block truncate text-[14px] text-ink hover:text-accent"
          >
            {item.title}
          </a>
          <p className="mt-0.5 font-mono text-[11px] uppercase tracking-wider text-muted">
            {categoryLabel(item.category)}
            {pct ? ` · ${pct} sure` : ""} · {item.ageLabel}
          </p>
          {item.reason && (
            <p className="mt-1 text-[12px] text-muted">&ldquo;{item.reason}&rdquo;</p>
          )}
        </div>
        {!published && (
          <button
            type="button"
            onClick={publishAnyway}
            disabled={isPending}
            className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-[13px] text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {isPending ? "Publishing…" : "Publish anyway"}
          </button>
        )}
      </div>
      {published && (
        <p className="mt-2 text-[12px] text-accent">
          Published. It is live on the site and queued for the enabled
          platforms.
        </p>
      )}
      {error && <p className="mt-2 text-[12px] text-accent">{error}</p>}
    </li>
  );
}
