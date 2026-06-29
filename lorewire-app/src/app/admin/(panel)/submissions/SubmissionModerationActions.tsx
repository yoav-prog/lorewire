"use client";

// Approve / Reject controls for one queued submission. Mirrors the comments
// ModerationActions: a useTransition around the co-located server action with a
// tiny error surface. Reject carries a reason category (defaulting to the AI's
// suggestion) so the author gets the matching user-safe message. On success the
// action revalidates /admin/submissions, so the row drops out on the next paint.

import { useState, useTransition } from "react";
import {
  approveAndRenderAction,
  approvePollOnlyAction,
  rejectSubmissionAction,
} from "./actions";

const REJECT_OPTIONS = [
  ["real_person", "Names a real person"],
  ["spam", "Spam / promo"],
  ["hate", "Hate / harassment"],
  ["sexual", "Sexual"],
  ["off_policy", "Not a dilemma"],
  ["low_effort", "Low effort"],
  ["borderline", "Other"],
] as const;

export function SubmissionModerationActions({
  submissionId,
  suggested,
}: {
  submissionId: string;
  suggested?: string | null;
}) {
  const [running, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [category, setCategory] = useState<string>(() =>
    REJECT_OPTIONS.some(([k]) => k === suggested) ? (suggested as string) : "borderline",
  );

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
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => run(() => approveAndRenderAction(submissionId))}
          disabled={running}
          className="rounded-md border border-cat-wholesome/40 bg-cat-wholesome/10 px-3 py-1.5 text-[12px] font-semibold text-cat-wholesome transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
        >
          Approve &amp; video
        </button>
        <button
          type="button"
          onClick={() => run(() => approvePollOnlyAction(submissionId))}
          disabled={running}
          className="rounded-md border border-line px-3 py-1.5 text-[12px] font-semibold text-muted transition-opacity hover:border-ink hover:text-ink disabled:cursor-wait disabled:opacity-50"
        >
          Poll only
        </button>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          disabled={running}
          aria-label="Rejection reason"
          className="rounded-md border border-line bg-bg px-2 py-1.5 text-[12px] text-ink focus:border-ink focus:outline-none disabled:opacity-50"
        >
          {REJECT_OPTIONS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => run(() => rejectSubmissionAction(submissionId, category))}
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
