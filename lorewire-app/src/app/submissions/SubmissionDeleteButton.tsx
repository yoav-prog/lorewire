"use client";

// Self-takedown control on the dashboard. Two-step (Delete -> Confirm) so a stray
// tap can't remove a submission. On success the action revalidates /submissions
// and the row re-renders as removed.

import { useState, useTransition } from "react";
import { eraseMySubmissionAction } from "./actions";

export function SubmissionDeleteButton({
  submissionId,
}: {
  submissionId: string;
}) {
  const [running, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function remove(): void {
    setErr(null);
    start(async () => {
      try {
        await eraseMySubmissionAction(submissionId);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Couldn't delete. Try again.");
        setConfirming(false);
      }
    });
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="font-mono uppercase tracking-[.15em] text-muted hover:text-danger"
      >
        Delete
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={remove}
        disabled={running}
        className="font-mono uppercase tracking-[.15em] text-danger hover:underline disabled:opacity-50"
      >
        {running ? "Deleting…" : "Confirm delete"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={running}
        className="font-mono uppercase tracking-[.15em] text-muted hover:text-ink disabled:opacity-50"
      >
        Cancel
      </button>
      {err && <span className="text-danger">{err}</span>}
    </span>
  );
}
