"use client";

// Sticky banner above the tabs showing the current render lane + estimated
// cost + "Render after edits" button. Phase 2 ships Lane A as executable;
// Lanes B / C surface with a "needs Phase X" disabled button so the admin
// sees the cost story but isn't blocked into a partial render.
//
// Polls previewRenderPlan after every saved patch (via the parent's
// configKey prop) so the banner reflects the latest diff against the
// baseline. The plan is cheap to compute (one DB read + a string diff),
// so re-evaluating per save is fine.
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md.

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ShortRenderPlan } from "@/lib/short-render-plan";
import { previewRenderPlan, renderShortLaneA } from "./actions";

const LANE_LABEL: Record<ShortRenderPlan["lane"], string> = {
  noop: "No changes",
  A: "Lane A · captions only",
  B: "Lane B · voice/script",
  C: "Lane C · per-scene",
};

const LANE_PHASE_HINT: Record<Exclude<ShortRenderPlan["lane"], "A" | "noop">, string> = {
  B: "Phase 3 will execute this",
  C: "Phase 4 will execute this",
};

function formatCents(cents: number): string {
  if (cents === 0) return "free";
  return `~$${(cents / 100).toFixed(2)}`;
}

export function RenderAfterEditsBanner({
  storyId,
  /** Bumps every time the parent's config changes (any tab edit), so the
   *  banner re-fetches the plan after the autosave has flushed. */
  configKey: configKeyProp,
}: {
  storyId: string;
  configKey: string;
}) {
  const router = useRouter();
  const [plan, setPlan] = useState<ShortRenderPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRender, setPendingRender] = useState(false);
  const [, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line no-console -- rule 14
    console.info("[short editor banner poll]", { storyId, configKey: configKeyProp });
    previewRenderPlan(storyId)
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) {
          setPlanError(r.error ?? "could not preview render plan");
          setPlan(null);
          return;
        }
        setPlanError(null);
        setPlan(r.plan ?? null);
      })
      .catch((e) => {
        if (!cancelled) {
          setPlanError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [storyId, configKeyProp]);

  // The banner intentionally renders ALWAYS — even on noop — so the user
  // sees the (idle) cost story. It just disables the button.
  const lane = plan?.lane ?? "noop";
  const ready = lane === "A";

  function onRender() {
    if (!ready) return;
    setActionError(null);
    setPendingRender(true);
    startTransition(async () => {
      const r = await renderShortLaneA(storyId);
      setPendingRender(false);
      if (!r.ok) {
        setActionError(r.error ?? "render failed to queue");
        return;
      }
      // eslint-disable-next-line no-console -- rule 14
      console.info("[short editor banner laneA]", {
        storyId,
        render_id: r.renderId,
      });
      router.refresh();
    });
  }

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 backdrop-blur">
      <div className="flex flex-1 flex-wrap items-baseline gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Render lane
        </span>
        <span className="font-mono text-[11px] text-ink">
          {LANE_LABEL[lane]}
        </span>
        {plan && plan.lane !== "noop" && (
          <span className="font-mono text-[10px] text-muted">
            · {formatCents(plan.estimated_cost_cents)}
          </span>
        )}
        {plan?.reason && (
          <span className="text-[11px] text-muted">· {plan.reason}</span>
        )}
      </div>

      {lane === "A" && (
        <button
          type="button"
          onClick={onRender}
          disabled={pendingRender}
          className="rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
          title={`Re-render the assembly with the new captions (~$${(plan!.estimated_cost_cents / 100).toFixed(2)})`}
        >
          {pendingRender ? "Queueing…" : "Render after edits"}
        </button>
      )}

      {(lane === "B" || lane === "C") && (
        <button
          type="button"
          disabled
          title={LANE_PHASE_HINT[lane]}
          className="rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted opacity-60"
        >
          Needs {LANE_PHASE_HINT[lane]}
        </button>
      )}

      {planError && (
        <span className="font-mono text-[10px] text-warn">{planError}</span>
      )}
      {actionError && (
        <span className="font-mono text-[10px] text-warn">{actionError}</span>
      )}
    </div>
  );
}
