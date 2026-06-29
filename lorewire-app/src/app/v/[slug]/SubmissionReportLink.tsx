"use client";

// "This is about me / report" control, shown at the foot of a published
// submission-origin story. Lets someone with no account flag a problem (e.g. it
// describes a real person). Posts to /api/submissions/report, which is origin-
// gated and rate-limited. Deliberately low-key so it doesn't invite noise.

import { useState } from "react";

export function SubmissionReportLink({ storyId }: { storyId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [err, setErr] = useState<string | null>(null);

  async function send(): Promise<void> {
    setState("sending");
    setErr(null);
    try {
      const res = await fetch("/api/submissions/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ storyId, reason }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!res.ok || !data?.ok) {
        setErr(data?.error ?? "Couldn't send. Try again.");
        setState("idle");
        return;
      }
      setState("done");
    } catch {
      setErr("Couldn't reach the server. Check your connection.");
      setState("idle");
    }
  }

  if (state === "done") {
    return (
      <p className="text-[12px] text-muted">Thanks. A person will review this.</p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[12px] text-muted underline decoration-line hover:text-ink"
      >
        This story is about me / report a problem
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        maxLength={1000}
        placeholder="What's the problem? For example: this describes a real person."
        className="block w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
      />
      {err && <p className="text-[12px] text-danger">{err}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={send}
          disabled={state === "sending"}
          className="rounded-md border border-ink bg-ink px-3 py-1.5 text-[12px] font-medium text-bg hover:opacity-90 disabled:opacity-60"
        >
          {state === "sending" ? "Sending…" : "Send report"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={state === "sending"}
          className="rounded-md border border-line px-3 py-1.5 text-[12px] text-muted hover:text-ink disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
