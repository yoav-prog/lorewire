"use client";

// Status step indicator for the story edit page. Phase E of the admin
// UI overhaul (_plans/2026-06-12-admin-ui-overhaul.md): replaces the
// loose row of four "Mark X" buttons with a real progression strip so
// the admin can see at a glance where this story sits in the workflow.
//
// Pattern: the three workflow steps render as connected pills with a
// filled track between them up to the current step. Clicking any
// pill submits `changeStatus` for that target status — same server
// contract as the old buttons. Archive lives below as a separate
// destructive-style action because it's a sidestep, not a step.
//
// Why a client component: each pill is its own micro-form posting via
// startTransition so the indicator stays interactive while React's
// router revalidates the route. The old form-per-button approach
// caused a full-document submit per click; this one feels live.

import { useTransition } from "react";
import { changeStatus } from "@/app/admin/actions";

interface Step {
  status: string;
  label: string;
  /** Order in the progression — used to fill the connector track to the
   *  current step. */
  order: number;
}

const STEPS: Step[] = [
  { status: "review", label: "In review", order: 0 },
  { status: "ready", label: "Ready", order: 1 },
  { status: "published", label: "Published", order: 2 },
];

// Where each non-step status sits relative to the progression. Treated as
// "before step 0" so the connector stays empty when the story hasn't
// reached review yet.
const PRE_REVIEW_STATUSES = new Set([
  "draft",
  "scripted",
  "rendering",
]);

export function StatusStepIndicator({
  storyId,
  currentStatus,
}: {
  storyId: string;
  currentStatus: string | null | undefined;
}) {
  const [isPending, startTransition] = useTransition();

  const status = (currentStatus ?? "draft").toLowerCase();
  const archived = status === "archived";
  const currentStep = STEPS.find((s) => s.status === status)?.order;
  // Connector fill: how far along the track to colour. If the current
  // status is not on the progression (draft/scripted/rendering/archived)
  // the fill is zero.
  const fillFraction =
    currentStep !== undefined && STEPS.length > 1
      ? currentStep / (STEPS.length - 1)
      : 0;

  function submit(targetStatus: string) {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("id", storyId);
      fd.set("status", targetStatus);
      console.info("[admin ui] status step", { storyId, targetStatus });
      await changeStatus(fd);
    });
  }

  return (
    <div data-testid="status-step-indicator" className="space-y-3">
      <div className="relative" role="group" aria-label="Workflow status">
        {/* Connector track. Sits behind the pills and runs across the
            centres of the three step buttons. */}
        <div
          aria-hidden
          className="absolute left-[10%] right-[10%] top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-surface2"
        />
        <div
          aria-hidden
          className="absolute left-[10%] top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-accent transition-[width] duration-150"
          style={{ width: `${fillFraction * 80}%` }}
        />
        <div className="relative flex items-center justify-between">
          {STEPS.map((step) => {
            const isCurrent = step.status === status;
            const isPast =
              currentStep !== undefined && step.order < currentStep;
            const isReachable =
              !isCurrent &&
              !archived &&
              (isPast || !PRE_REVIEW_STATUSES.has(status) || step.order === 0);
            const pillClass = isCurrent
              ? "border-accent bg-accent text-bg"
              : isPast
                ? "border-accent bg-bg text-accent"
                : "border-line bg-bg text-muted hover:border-ink hover:text-ink";
            return (
              <button
                key={step.status}
                type="button"
                onClick={() => submit(step.status)}
                disabled={isPending || isCurrent}
                aria-current={isCurrent ? "step" : undefined}
                data-step={step.status}
                title={
                  isCurrent
                    ? `Current status: ${step.label}`
                    : isReachable
                      ? `Move to ${step.label}`
                      : `Set status to ${step.label}`
                }
                className={`relative flex min-w-[96px] items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed ${pillClass} ${
                  isPending ? "opacity-70" : ""
                }`}
              >
                <span
                  aria-hidden
                  className={`inline-flex h-4 w-4 items-center justify-center rounded-full border text-[9px] ${
                    isCurrent
                      ? "border-bg bg-bg text-accent"
                      : isPast
                        ? "border-accent text-accent"
                        : "border-line text-muted"
                  }`}
                >
                  {step.order + 1}
                </span>
                <span>{step.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
          {archived
            ? "Archived — hidden from feeds"
            : PRE_REVIEW_STATUSES.has(status)
              ? `Draft (${status}) — start by marking in review`
              : `Current: ${status}`}
        </p>
        <button
          type="button"
          onClick={() => submit(archived ? "ready" : "archived")}
          disabled={isPending}
          className={`rounded-md border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
            archived
              ? "border-accent text-accent hover:bg-accent/10"
              : "border-line text-muted hover:border-danger hover:text-danger"
          } ${isPending ? "opacity-70" : ""}`}
        >
          {archived ? "Unarchive" : "Archive"}
        </button>
      </div>
    </div>
  );
}
