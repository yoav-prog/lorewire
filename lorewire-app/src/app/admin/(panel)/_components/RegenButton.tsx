"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  enqueueImageRegenAction,
  type EnqueueImageRegenResult,
} from "@/app/admin/actions";

// Click-to-regenerate button. One row per asset on the MediaRegenPanel.
// Shows the estimated cost as a chip, flips to a pending state during the
// server action, and surfaces cap-exceeded errors inline so the admin sees
// "today: $X.XX of $Y" instead of a vague "something went wrong."
//
// On success, kicks router.refresh() so the parent server component re-reads
// the queue and the new row shows up in the panel without a full page reload.
//
// No success-state chip lives on the button. The latest-render line right
// below the hint (Queued · 2s ago → Generating · 15s ago → Last regenerated …)
// is the source of truth; a sticky "Queued." chip on the button never cleared
// after the row settled, which read as "queued forever" even when the regen
// had completed cleanly minutes earlier.

interface RegenButtonProps {
  ownerKind: "story" | "article";
  ownerId: string;
  asset: string;
  /** Pre-computed estimate from the server. Shown as a chip. */
  estimateCents: number;
  /** When true, render bigger as the primary action on this row. */
  primary?: boolean;
  label?: string;
}

export function RegenButton({
  ownerKind,
  ownerId,
  asset,
  estimateCents,
  primary = false,
  label = "Regenerate",
}: RegenButtonProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<EnqueueImageRegenResult | null>(null);

  function fire() {
    startTransition(async () => {
      const r = await enqueueImageRegenAction({ ownerKind, ownerId, asset });
      setResult(r);
      if (r.ok) {
        router.refresh();
      }
    });
  }

  const estimate = formatCents(estimateCents);
  const baseClass = primary
    ? "rounded-lg bg-accent px-3 py-1.5 font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
    : "rounded-md border border-line px-2.5 py-1 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-50";

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <span className="rounded-full border border-line bg-surface2 px-2 py-0.5 font-mono text-[10px] text-muted">
          ≈ {estimate}
        </span>
        <button
          type="button"
          onClick={fire}
          disabled={pending}
          className={baseClass}
        >
          {pending ? "Enqueuing…" : label}
        </button>
      </div>
      {result && !result.ok && (
        <p className="text-[11px] text-danger">
          {explainError(result)}
        </p>
      )}
    </div>
  );
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function explainError(r: EnqueueImageRegenResult): string {
  if (r.error === "daily-budget-exceeded" && r.capCents != null && r.spentCents != null) {
    return `Daily budget used: ${formatCents(r.spentCents)} of ${formatCents(r.capCents)}. Try tomorrow or raise the cap in Settings.`;
  }
  return r.error ?? "Enqueue failed";
}
