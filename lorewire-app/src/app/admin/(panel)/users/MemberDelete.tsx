"use client";

// Danger-zone delete control on the member detail page. Renders only for staff
// with users.delete. The confirm dialog NAMES the person, spells out that the
// erase is permanent, and requires typing the member's email to enable the
// button — the typed confirmation, not just a click, is what stops an
// irreversible mistake. The server re-checks the same things (defense in depth).
//
// Phase 4 of _plans/2026-06-22-admin-user-management.md.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { deleteMemberAction } from "./actions";

interface MemberDeleteProps {
  userId: string;
  userEmail: string;
  userLabel: string;
  canDelete: boolean;
  /** When set, deletion is blocked (self / unsuspended admin); disables the button. */
  blockedReason: string | null;
}

export default function MemberDelete({
  userId,
  userEmail,
  userLabel,
  canDelete,
  blockedReason,
}: MemberDeleteProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!canDelete) return null;

  const matches = typed.trim().toLowerCase() === userEmail.trim().toLowerCase();

  function runDelete() {
    setError(null);
    startTransition(async () => {
      const res = await deleteMemberAction(userId, typed, password);
      if (res.ok) {
        // The account no longer exists — leave the (now-404) detail page.
        router.push("/admin/users");
      } else {
        setError(res.error ?? "Couldn't delete this account.");
      }
    });
  }

  return (
    <div className="rounded-xl border border-danger/40 bg-danger/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-display text-[14px] font-bold text-danger">
            Danger zone
          </div>
          <p className="mt-0.5 text-[12px] text-muted">
            Permanently delete this account and all personal data (GDPR erase).
            This can&apos;t be undone.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setTyped("");
            setPassword("");
            setOpen(true);
          }}
          disabled={Boolean(blockedReason)}
          title={blockedReason ?? undefined}
          className="rounded-lg border border-danger px-3 py-1.5 text-[13px] font-semibold text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Delete account
        </button>
      </div>
      {blockedReason && (
        <p className="mt-2 text-[12px] text-muted">{blockedReason}</p>
      )}
      {error && !open && <p className="mt-2 text-[12px] text-danger">{error}</p>}

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-title"
          className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-6"
        >
          <div className="w-full max-w-md rounded-xl border border-danger/40 bg-surface p-5 shadow-2xl">
            <h3
              id="delete-title"
              className="font-display text-[16px] font-bold text-danger"
            >
              Delete {userLabel}?
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              This permanently erases the account and every piece of personal
              data tied to it — saves, likes, history, profile. Their poll votes
              are kept but fully anonymized.
              <span className="text-ink"> This cannot be undone.</span>
            </p>
            <label className="mt-3 block">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                Type <span className="text-ink">{userEmail}</span> to confirm
              </span>
              <input
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-danger"
              />
            </label>
            <label className="mt-3 block">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                Confirm your password
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-danger"
              />
            </label>
            {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={runDelete}
                disabled={pending || !matches || !password}
                className="flex-1 rounded-lg border border-danger bg-danger/15 px-4 py-2 font-semibold text-danger transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? "Deleting…" : "Permanently delete"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setError(null);
                }}
                disabled={pending}
                className="flex-1 rounded-lg border border-line bg-surface px-4 py-2 text-ink transition-colors hover:border-accent disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
