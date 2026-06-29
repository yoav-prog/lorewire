"use client";

// Take down / Dismiss controls for a victim report on a published submission
// story. Mirrors the moderation actions: useTransition around the co-located
// server action, with a tiny error surface. On success the action revalidates
// /admin/submissions and the report drops out of the list.

import { useState, useTransition } from "react";
import { dismissReportedAction, takeDownReportedAction } from "./actions";

export function ReportActions({
  submissionId,
  storyId,
}: {
  submissionId: string;
  storyId: string;
}) {
  const [running, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function run(fn: () => Promise<void>): void {
    setErr(null);
    start(async () => {
      try {
        await fn();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => run(() => takeDownReportedAction(submissionId, storyId))}
          disabled={running}
          className="rounded-md border border-cat-entitled/40 bg-cat-entitled/10 px-3 py-1.5 text-[12px] font-semibold text-cat-entitled transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
        >
          Take down
        </button>
        <button
          type="button"
          onClick={() => run(() => dismissReportedAction(storyId))}
          disabled={running}
          className="rounded-md border border-line px-3 py-1.5 text-[12px] font-semibold text-muted transition-opacity hover:border-ink hover:text-ink disabled:cursor-wait disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
      {err && (
        <p className="text-right font-mono text-[10px] text-cat-entitled">{err}</p>
      )}
    </div>
  );
}
