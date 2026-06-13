"use client";

// "Stop all" button. Cancels every queued or in-flight image_renders row
// for one owner in a single click. Lives in the MediaRegenPanel header
// next to "Rebuild all media" and only shows when at least one row is
// active.
//
// Confirm modal is intentional: this is destructive (you can't un-cancel
// a row), the user pays for nothing, but a misclick during an active 27-
// scene job loses progress and forces a fresh start.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelAllImageRendersAction } from "@/app/admin/actions";
import type { AssetOwnerKind } from "@/lib/image-render-queue";

export function StopAllButton({
  ownerKind,
  ownerId,
  activeCount,
}: {
  ownerKind: AssetOwnerKind;
  ownerId: string;
  /** Count of queued + generating rows. Hides the button when zero. */
  activeCount: number;
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function fire() {
    setError(null);
    startTransition(async () => {
      const r = await cancelAllImageRendersAction({ ownerKind, ownerId });
      if (!r.ok) {
        setError(r.error ?? "Stop failed");
        return;
      }
      setConfirmOpen(false);
      router.refresh();
    });
  }

  if (activeCount === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={pending}
        className="rounded-md border border-danger/60 bg-danger/10 px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-danger transition-colors hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending
          ? "Stopping…"
          : `Stop all (${activeCount})`}
      </button>
      {confirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="stop-all-title"
          className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-6"
        >
          <div className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-2xl">
            <h3
              id="stop-all-title"
              className="font-display text-[16px] font-bold text-ink"
            >
              Stop every active media job for this {ownerKind}?
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              Cancels {activeCount}{" "}
              {activeCount === 1 ? "job" : "jobs"} that{" "}
              {activeCount === 1 ? "is" : "are"} queued or in flight.
              Anything already saved stays saved; in-flight images that
              have not been written are discarded. You can re-queue from
              the per-asset Regenerate buttons.
            </p>
            {error && (
              <p className="mt-3 rounded-md border border-danger/40 bg-danger/10 p-2 font-mono text-[10px] text-danger">
                {error}
              </p>
            )}
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={fire}
                disabled={pending}
                className="flex-1 rounded-md bg-danger px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pending ? "Stopping…" : "Stop all"}
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
