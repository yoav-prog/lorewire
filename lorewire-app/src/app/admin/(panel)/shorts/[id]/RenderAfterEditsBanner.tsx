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

// Cost the noop-force re-render falls into — Lane A is the cheapest
// fully-deterministic path (assembly only, no kie regen) so a "render
// anyway" click can't accidentally burn a kie scene regen.
const LANE_A_FALLBACK_CENTS = 5;

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
  // noop: the planner thinks nothing changed since the last successful
  // render. We still expose the button so an admin can force a fresh
  // render — for cases where the planner missed a change (recently:
  // intro/outro overrides set + a stamping race that left the planner
  // showing "no changes" while the rendered MP4 actually had no
  // splice) or just to refresh the artifact.
  return `Force a fresh Lane A assembly with the current state (~$${(LANE_A_FALLBACK_CENTS / 100).toFixed(2)})`;
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

  // Render button is ALWAYS available — even on noop. The user explicitly
  // asked for an "always re-render" escape hatch because the planner
  // occasionally misses an upstream change (the original ask in
  // 2026-06-17: intro/outro override stamping race that left the
  // planner reading "no changes" right after an admin set both
  // overrides). On noop, we route through Lane A — assembly only, no
  // kie regen cost, deterministic.
  const lane = plan?.lane ?? "noop";
  // True once the initial preview round-trip has resolved (success OR
  // error). We don't disable on noop, only while the round-trip is
  // still in flight — otherwise the button flashes available before
  // the lane is known.
  const planLoaded = plan !== null || planError !== null;

  function onRender() {
    setActionError(null);
    setPendingRender(true);
    startTransition(async () => {
      // noop and Lane A both route through renderShortLaneA. The Lane A
      // action accepts a noop plan now (force=true semantics) so an
      // admin can refresh the artifact without depending on the
      // planner detecting a delta. B + C keep their dedicated routes.
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

      {planLoaded && (
        <button
          type="button"
          onClick={onRender}
          disabled={pendingRender}
          className="rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
          title={plan ? renderTooltip(lane, plan) : "Force a fresh render"}
        >
          {pendingRender
            ? "Queueing…"
            : lane === "noop"
              ? "Re-render anyway"
              : "Render after edits"}
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
