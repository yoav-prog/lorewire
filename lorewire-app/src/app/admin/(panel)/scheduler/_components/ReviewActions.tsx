"use client";

// Approve / Reject buttons for one reviewed story. Approve publishes the
// story and queues its social posts across enabled platforms; Reject sends
// it back to draft. Both show inline feedback and settle to a done state so
// the row visibly resolves without a full reload.

import { useState, useTransition } from "react";
import {
  schedulerApproveStoryAction,
  schedulerRejectStoryAction,
} from "@/app/admin/scheduler-actions";

export function ReviewActions({ storyId }: { storyId: string }) {
  const [isPending, startTransition] = useTransition();
  const [settled, setSettled] = useState<null | "approved" | "rejected">(null);
  const [message, setMessage] = useState<string | null>(null);

  function approve() {
    setMessage(null);
    startTransition(async () => {
      const r = await schedulerApproveStoryAction(storyId);
      if (r.ok) {
        setSettled("approved");
        setMessage(
          r.publishEnabled
            ? `Approved — scheduled on ${r.scheduled} platform${r.scheduled === 1 ? "" : "s"}`
            : "Approved and published (publish scheduler is off, so nothing was queued)",
        );
      } else {
        const detail =
          r.missing && r.missing.length > 0 ? ` (${r.missing.join(", ")})` : "";
        setMessage(`Can't approve: ${r.error}${detail}`);
      }
    });
  }

  function reject() {
    setMessage(null);
    startTransition(async () => {
      const r = await schedulerRejectStoryAction(storyId);
      if (r.ok) {
        setSettled("rejected");
        setMessage("Rejected — sent back to draft");
      } else {
        setMessage(r.error ?? "Reject failed");
      }
    });
  }

  if (settled) {
    return (
      <span
        className={`text-[12px] ${settled === "approved" ? "text-ink" : "text-muted"}`}
      >
        {message}
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={isPending}
          onClick={approve}
          className="rounded-lg border border-accent bg-accent/10 px-3 py-1.5 text-[13px] font-semibold text-accent transition-colors hover:bg-accent hover:text-bg disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={reject}
          className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-muted transition-colors hover:border-accent hover:text-ink disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      {message && <span className="text-[12px] text-accent">{message}</span>}
    </div>
  );
}
