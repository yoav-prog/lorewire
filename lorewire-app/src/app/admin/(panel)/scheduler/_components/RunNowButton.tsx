"use client";

// "Run now" for the Autopilot panel: fires one pull + approve tick
// immediately (the same pair the 2-minute cron runs) so an admin does not
// have to wait — and so autopilot is usable in local dev / preview
// deploys where Vercel crons do not fire. Calls the admin-gated server
// action and shows a one-line result. Not a shortcut past any gate: the
// tick still honours mode, budget, headroom, the safety judge, and the
// breaker.

import { useState, useTransition } from "react";
import {
  runAutopilotTickNowAction,
  type RunAutopilotNowResult,
} from "@/app/admin/scheduler-actions";

// Friendly text for each pull reason the tick can report back.
const PULL_LABEL: Record<string, string> = {
  off: "autopilot is off",
  budget_exhausted: "today's budget is spent",
  queue_not_empty: "waiting for your review queue to clear (Live only)",
  daily_limit_reached: "daily limit reached",
  no_headroom: "the review queue is full",
  no_candidates: "no eligible sources in the pool",
};

function summarize(r: RunAutopilotNowResult): string {
  if (!r.ok) return r.error ?? "run failed";
  const parts: string[] = [];
  if (r.pull) {
    parts.push(
      r.pull.reason === "ok"
        ? `Pulled ${r.pull.enqueued} source${r.pull.enqueued === 1 ? "" : "s"} to render`
        : `Nothing pulled: ${PULL_LABEL[r.pull.reason] ?? r.pull.reason}`,
    );
  }
  // 'not_live' just means this mode does not auto-publish (shadow/off); no
  // need to surface publish counts then. Deferred (waiting on assets,
  // retried next tick) only shows when non-zero to keep the line short.
  if (r.approve && r.approve.reason !== "not_live") {
    const counts = [
      `published ${r.approve.approved}`,
      `held ${r.approve.held}`,
      ...(r.approve.deferred > 0
        ? [`waiting on assets ${r.approve.deferred}`]
        : []),
      `failed ${r.approve.failed}`,
    ];
    parts.push(counts.join(", "));
  }
  if (r.approve?.tripped) parts.push("breaker tripped, autopilot is now off");
  return parts.join(" · ");
}

export function RunNowButton() {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RunAutopilotNowResult | null>(null);

  function run() {
    setResult(null);
    startTransition(async () => {
      setResult(await runAutopilotTickNowAction());
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={isPending}
        className="rounded-lg border border-accent bg-accent/10 px-3 py-1.5 text-[13px] font-semibold text-accent transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {isPending ? "Running one tick..." : "Run now"}
      </button>
      {result && (
        <span className="font-mono text-[12px] text-muted">
          {summarize(result)}
        </span>
      )}
    </div>
  );
}
