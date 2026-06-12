"use client";

// One-click bulk rebuild for every asset shown in the MediaRegenPanel.
// Picks up the same per-asset cost estimates the panel already computed
// so the confirmation dialog can quote the rough total before any queue
// row gets written. Each asset goes through the same
// `enqueueImageRegenAction` the per-asset RegenButton uses, so the budget
// gate + the per-asset queue row + the panel's polling all "just work."
// Failures partway through don't abort the rest — the admin can re-click
// the per-asset button for any that didn't enqueue.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { enqueueImageRegenAction } from "@/app/admin/actions";
import type { AssetOwnerKind } from "@/lib/image-render-queue";

export interface RebuildAllSpec {
  asset: string;
  label: string;
  estimateCents: number;
}

export function RebuildAllButton({
  ownerKind,
  ownerId,
  specs,
}: {
  ownerKind: AssetOwnerKind;
  ownerId: string;
  specs: RebuildAllSpec[];
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [failures, setFailures] = useState<string[]>([]);

  const totalCents = specs.reduce((sum, s) => sum + s.estimateCents, 0);
  const totalUsd = (totalCents / 100).toFixed(2);

  function fire() {
    setFailures([]);
    startTransition(async () => {
      const failed: string[] = [];
      // Sequential so the budget gate sees the running total. Parallel
      // would race on the cap and risk over-spend.
      for (const spec of specs) {
        try {
          const r = await enqueueImageRegenAction({
            ownerKind,
            ownerId,
            asset: spec.asset,
          });
          if (!r.ok) {
            failed.push(`${spec.label}: ${r.error ?? "enqueue failed"}`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          failed.push(`${spec.label}: ${msg}`);
        }
      }
      console.info("[admin ui] rebuild all media", {
        ownerKind,
        ownerId,
        total: specs.length,
        failed: failed.length,
      });
      setFailures(failed);
      setConfirmOpen(false);
      // Revalidate the page so the MediaRegenPanel's queue rows refresh.
      router.refresh();
    });
  }

  if (specs.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={pending}
        className="w-full rounded-md border border-accent bg-accent/15 px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-accent transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending
          ? "Queueing…"
          : `Rebuild all media (~$${totalUsd}, ${specs.length} assets)`}
      </button>
      {failures.length > 0 && (
        <ul className="mt-2 space-y-1 rounded-md border border-danger/40 bg-danger/10 p-2 font-mono text-[10px] text-danger">
          {failures.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
      {confirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="rebuild-all-title"
          className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-6"
        >
          <div className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-2xl">
            <h3
              id="rebuild-all-title"
              className="font-display text-[16px] font-bold text-ink"
            >
              Rebuild every asset for this {ownerKind}?
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              Queues a regen for each asset in turn through the same daily
              budget gate the per-asset buttons use. The worker drains them
              one at a time; this page polls every few seconds while any
              row is in flight.
            </p>
            <ul className="mt-3 space-y-1 rounded-md border border-line bg-bg p-3 font-mono text-[11px] text-muted">
              {specs.map((s) => (
                <li key={s.asset} className="flex justify-between gap-2">
                  <span className="truncate">{s.label}</span>
                  <span className="shrink-0 text-ink">
                    ~${(s.estimateCents / 100).toFixed(2)}
                  </span>
                </li>
              ))}
              <li className="mt-1 flex justify-between border-t border-line pt-1 font-semibold text-ink">
                <span>Estimated total</span>
                <span>~${totalUsd}</span>
              </li>
            </ul>
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={fire}
                disabled={pending}
                className="flex-1 rounded-md bg-accent px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pending ? "Queueing…" : `Queue all (~$${totalUsd})`}
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={pending}
                className="rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
