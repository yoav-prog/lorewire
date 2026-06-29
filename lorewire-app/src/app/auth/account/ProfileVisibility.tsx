"use client";

// Account section: show or hide the public contributor profile (/u/[id]).
// Opt-out only — the default is visible. Posts to /api/user/profile-visibility
// with an optimistic flip and rollback on failure, the same shape the rest of
// the account form uses.
//
// Plan: _plans/2026-06-29-contributor-profiles-gamification.md.

import { useState } from "react";

export default function ProfileVisibility({
  initialHidden,
}: {
  initialHidden: boolean;
}) {
  const [hidden, setHidden] = useState(initialHidden);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function apply(nextHidden: boolean): Promise<void> {
    if (busy) return;
    const prev = hidden;
    setHidden(nextHidden); // optimistic
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/user/profile-visibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ hidden: nextHidden }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!res.ok || !data?.ok) {
        setHidden(prev);
        setErr(data?.error ?? "Couldn't save. Try again.");
      }
    } catch {
      setHidden(prev);
      setErr("Couldn't reach the server. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  const visible = !hidden;

  return (
    <section className="mt-8 border-t border-line pt-6">
      <h2 className="font-display text-lg font-bold uppercase tracking-tight text-ink">
        Contributor profile
      </h2>
      <p className="mt-1 text-sm text-muted">
        Your public profile shows your rank, badge, and how much you&apos;ve
        contributed (submissions, comments, votes). It&apos;s linked from stories
        you submit. It never shows your email or how you voted.
      </p>
      <label className="mt-3 flex items-center gap-3">
        <input
          type="checkbox"
          checked={visible}
          disabled={busy}
          onChange={(e) => apply(!e.target.checked)}
          className="h-4 w-4 rounded border-line text-ink focus:ring-0 disabled:opacity-50"
        />
        <span className="text-sm text-ink">
          {visible
            ? "Visible to everyone"
            : "Hidden — only you can see your stats"}
        </span>
      </label>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
    </section>
  );
}
