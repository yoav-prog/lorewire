"use client";

// Editor-header button that fires a bulk "Regenerate all scene images"
// for the current story. Thin wrapper around `enqueueImageRegenAction`
// with asset="scenes" — the action dispatches to enqueueScenesBulk and
// queues N per-scene rows so the cron drain can handle them inside its
// per-tick deadline (see _plans/2026-06-13-stop-button-and-per-scene-
// queue.md).
//
// Visual contract matches the editor's design tokens (mono uppercase
// label, border-line bg-surface base, accent hover) so it sits next to
// the aspect picker without standing out.
//
// Confirmation modal is intentional: a 27-image rebuild burns ~$1.35 of
// kie credit and isn't undoable. Per CLAUDE.md rule 10 (build for a
// lazy user) the dialog leads with what'll happen + the cost.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  enqueueImageRegenAction,
  type EnqueueImageRegenResult,
} from "@/app/admin/actions";

export interface RegenerateAllImagesButtonProps {
  storyId: string;
  /** Frame count from the editor's draft config. Used purely for the
   *  label + the dialog body; the server-side budget gate and the row
   *  inserts read media.scene_count for the actual count. The two can
   *  drift by ~3 (auto-derived 27 vs default 30); the dialog is honest
   *  about that. */
  sceneCount: number;
  /** Per-image estimate cents from estimateImageRegenCostCents — same
   *  number the per-frame card chips display. */
  perImageEstimateCents: number;
  /** Hides the button when no scenes exist. Matches how the MediaRegenPanel
   *  hides assets that have nothing to regen. */
  enabled?: boolean;
}

export function RegenerateAllImagesButton({
  storyId,
  sceneCount,
  perImageEstimateCents,
  enabled = true,
}: RegenerateAllImagesButtonProps) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<EnqueueImageRegenResult | null>(null);

  const totalCents = sceneCount * perImageEstimateCents;
  const totalUsd = (totalCents / 100).toFixed(2);

  if (!enabled || sceneCount <= 0) return null;

  function fire() {
    setResult(null);
    startTransition(async () => {
      // eslint-disable-next-line no-console -- rule 14
      console.info("[editor regen-all] fire", {
        story_id: storyId,
        scene_count: sceneCount,
        estimate_cents: totalCents,
      });
      const r = await enqueueImageRegenAction({
        ownerKind: "story",
        ownerId: storyId,
        asset: "scenes",
      });
      setResult(r);
      if (r.ok) {
        setConfirmOpen(false);
        router.refresh();
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setResult(null);
          setConfirmOpen(true);
        }}
        disabled={pending}
        className="rounded-md border border-line bg-surface px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="regenerate-all-images-button"
      >
        {pending
          ? "Queueing…"
          : `Regenerate all images (${sceneCount}, ~$${totalUsd})`}
      </button>

      {confirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="regen-all-images-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 p-6"
        >
          <div className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-2xl">
            <h3
              id="regen-all-images-title"
              className="font-display text-[16px] font-bold text-ink"
            >
              Rebuild every scene image?
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              Queues a fresh image for every scene through the daily
              budget gate. Each scene becomes its own job so the cron
              drain can handle them one at a time; per-frame status pills
              light up as each one lands.
            </p>
            <ul className="mt-3 space-y-1 rounded-md border border-line bg-bg p-3 font-mono text-[11px] text-muted">
              <li className="flex items-center justify-between gap-2">
                <span>Scenes (editor count)</span>
                <span className="text-ink">{sceneCount}</span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span>Per image (~estimate)</span>
                <span className="text-ink">
                  ${(perImageEstimateCents / 100).toFixed(2)}
                </span>
              </li>
              <li className="mt-1 flex items-center justify-between gap-2 border-t border-line pt-1 font-semibold text-ink">
                <span>Estimated total</span>
                <span>~${totalUsd}</span>
              </li>
            </ul>
            <p className="mt-2 text-[11px] text-muted">
              The server uses the settings-pinned scene count for the
              actual queue insert. If that differs from the editor count,
              the queue may be slightly bigger or smaller than shown.
            </p>
            {result && !result.ok && (
              <p className="mt-3 rounded-md border border-danger/40 bg-danger/10 p-2 font-mono text-[10px] text-danger">
                {explainError(result)}
              </p>
            )}
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

function explainError(r: EnqueueImageRegenResult): string {
  if (
    r.error === "daily-budget-exceeded" &&
    r.capCents != null &&
    r.spentCents != null
  ) {
    return `Daily budget used: $${(r.spentCents / 100).toFixed(2)} of $${(r.capCents / 100).toFixed(2)}. Raise the cap in Settings or wait.`;
  }
  return r.error ?? "Enqueue failed";
}
