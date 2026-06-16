"use client";

// Sticky banner above the tabs showing the current render lane + estimated
// cost + "Render after edits" button. Phase 4 ships all three lanes
// executable (A captions-only, B voice+assembly, C per-scene+assembly).
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
import {
  previewRenderPlan,
  renderShortLaneA,
  renderShortLaneB,
  renderShortLaneC,
} from "./actions";

const LANE_LABEL: Record<ShortRenderPlan["lane"], string> = {
  noop: "No changes",
  A: "Lane A · captions only",
  B: "Lane B · voice/script",
  C: "Lane C · per-scene",
};

function formatCents(cents: number): string {
  if (cents === 0) return "free";
  return `~$${(cents / 100).toFixed(2)}`;
}

function renderTooltip(
  lane: ShortRenderPlan["lane"],
  plan: ShortRenderPlan,
): string {
  const cost = `~$${(plan.estimated_cost_cents / 100).toFixed(2)}`;
  if (lane === "A") {
    return `Re-render the assembly with the new captions (${cost})`;
  }
  if (lane === "B") {
    return `Resynthesize voice + re-render (${cost})`;
  }
  if (lane === "C") {
    const n = plan.touched_scene_ids.length;
    return `Regenerate ${n} scene${n === 1 ? "" : "s"} + re-render assembly (${cost})`;
  }
  return cost;
}

export function RenderAfterEditsBanner({
  storyId,
  /** Bumps every time the parent's config changes (any tab edit), so the
   *  banner re-fetches the plan after the autosave has flushed. */
  configKey: configKeyProp,
  /** Optional notify-up callback. When the action returns a render_id the
   *  banner calls this so the parent (ShortEditorClient) can flip its
   *  RenderStatusPanel onto the new id without waiting for
   *  router.refresh() to re-flow server props. */
  onRenderQueued,
}: {
  storyId: string;
  configKey: string;
  onRenderQueued?: (renderId: string) => void;
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
  const ready = lane === "A" || lane === "B" || lane === "C";

  function onRender() {
    if (!ready) return;
    setActionError(null);
    setPendingRender(true);
    startTransition(async () => {
      const r =
        lane === "C"
          ? await renderShortLaneC(storyId)
          : lane === "B"
            ? await renderShortLaneB(storyId)
            : await renderShortLaneA(storyId);
      setPendingRender(false);
      if (!r.ok) {
        setActionError(r.error ?? "render failed to queue");
        return;
      }
      // eslint-disable-next-line no-console -- rule 14
      console.info("[short editor banner lane]", {
        storyId,
        lane,
        render_id: r.renderId,
      });
      if (r.renderId && onRenderQueued) {
        onRenderQueued(r.renderId);
      }
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

      {ready && plan && (
        <button
          type="button"
          onClick={onRender}
          disabled={pendingRender}
          className="rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
          title={renderTooltip(lane, plan)}
        >
          {pendingRender ? "Queueing…" : "Render after edits"}
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
