"use client";

// Approve / Reject controls for one queued comment. Mirrors the BackfillButton
// pattern: a useTransition around the co-located server action, with a tiny
// error surface. On success the action revalidates /admin/comments, so the row
// drops out of the list on the next paint — no client list state to keep.

import { useState, useTransition } from "react";
import {
  approveCommentAction,
  dismissReportsAction,
  rejectCommentAction,
} from "./actions";

// "moderate" = a held/quarantined comment awaiting a decision (Approve/Reject).
// "reported" = an already-published comment readers flagged (Keep/Reject).
export function ModerationActions({
  commentId,
  variant = "moderate",
}: {
  commentId: string;
  variant?: "moderate" | "reported";
}) {
  const [running, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function run(action: (id: string) => Promise<void>): void {
    setErr(null);
    start(async () => {
      try {
        await action(commentId);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    });
  }

  const keepAction = variant === "reported" ? dismissReportsAction : approveCommentAction;
  const keepLabel = variant === "reported" ? "Keep" : "Approve";

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => run(keepAction)}
          disabled={running}
          className="rounded-md border border-cat-wholesome/40 bg-cat-wholesome/10 px-3 py-1.5 text-[12px] font-semibold text-cat-wholesome transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
        >
          {keepLabel}
        </button>
        <button
          type="button"
          onClick={() => run(rejectCommentAction)}
          disabled={running}
          className="rounded-md border border-cat-entitled/40 bg-cat-entitled/10 px-3 py-1.5 text-[12px] font-semibold text-cat-entitled transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      {err && (
        <p className="text-right font-mono text-[10px] text-cat-entitled">{err}</p>
      )}
    </div>
  );
}
