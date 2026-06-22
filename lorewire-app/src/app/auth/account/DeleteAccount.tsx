"use client";

// Danger zone for the account page: permanent, self-serve account deletion.
//
// Deliberately high-friction (the opposite of the rest of the form): deletion
// is irreversible and there's no undo, so a single mis-tap must not trigger it.
// Two gates — the section is collapsed until opened, and the confirm button
// stays disabled until the user types the word DELETE. The panel spells out
// exactly what is removed so nobody is surprised after the fact.
//
// Posts to /api/user/delete; on success the account (and session) are gone, so
// we hard-navigate home rather than trying to re-render this page against a
// user row that no longer exists.
//
// Plan: _plans/2026-06-22-facebook-login-and-data-deletion.md §C.

import { useState } from "react";

export default function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canDelete = confirmText.trim().toLowerCase() === "delete";

  async function onDelete() {
    if (!canDelete || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/user/delete", {
        method: "POST",
        credentials: "same-origin",
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!res.ok || !data?.ok) {
        setErr(data?.error ?? "Couldn't delete your account. Try again.");
        setBusy(false);
        return;
      }
      // Account + session are gone. Go home; the app re-renders anonymous.
      window.location.assign("/");
    } catch (e) {
      console.warn("[account delete network]", { err: String(e) });
      setErr("Network problem. Try again.");
      setBusy(false);
    }
  }

  return (
    <section className="mt-12 border-t border-line pt-8">
      <h2 className="text-[12px] font-mono uppercase tracking-[.2em] text-muted">
        Danger zone
      </h2>

      {!open ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            Permanently delete your account and everything tied to it.
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-md border border-danger/50 bg-transparent px-4 py-2 text-sm font-medium text-danger hover:border-danger hover:bg-danger/10"
          >
            Delete my account
          </button>
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-danger/40 bg-danger/10 p-4">
          <p className="text-sm font-semibold text-ink">
            This permanently deletes your account. It can&apos;t be undone.
          </p>
          <p className="mt-2 text-[13px] text-muted">The following are erased:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-muted">
            <li>Your saved stories (My List) and likes</li>
            <li>Your reading and watching history</li>
            <li>Your profile (name and picture)</li>
            <li>The link between you and any poll votes you cast</li>
          </ul>
          <p className="mt-2 text-[12px] text-muted">
            Votes stay counted in anonymous poll totals but are no longer tied
            to you.
          </p>

          <label htmlFor="lw-delete-confirm" className="mt-4 block">
            <span className="block text-[12px] font-mono uppercase tracking-[.2em] text-muted">
              Type DELETE to confirm
            </span>
            <input
              id="lw-delete-confirm"
              type="text"
              autoComplete="off"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              disabled={busy}
              placeholder="DELETE"
              className="mt-1 block w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-danger focus:outline-none disabled:opacity-60"
            />
          </label>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onDelete}
              disabled={busy || !canDelete}
              className="rounded-md border border-danger bg-danger px-4 py-2 text-sm font-semibold text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Deleting…" : "Delete my account permanently"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setConfirmText("");
                setErr(null);
              }}
              disabled={busy}
              className="rounded-md border border-line bg-transparent px-4 py-2 text-sm text-muted hover:border-ink hover:text-ink disabled:opacity-60"
            >
              Cancel
            </button>
            {err ? (
              <span className="text-[12px] text-danger" role="alert">
                {err}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
