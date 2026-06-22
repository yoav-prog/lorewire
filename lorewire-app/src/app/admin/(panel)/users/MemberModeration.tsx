"use client";

// Suspend / unsuspend control on the member detail page. The suspended banner
// is visible to everyone (so a read-only viewer still sees the state); the
// action buttons render only for staff with users.moderate. Suspending opens a
// confirm dialog that NAMES the person and takes an optional reason (emailed to
// them) — the named confirm, not the disabled button, is what stops a tired
// admin from suspending the wrong row off a fast list.
//
// Phase 3 of _plans/2026-06-22-admin-user-management.md.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { suspendMemberAction, unsuspendMemberAction } from "./actions";

interface MemberModerationProps {
  userId: string;
  /** "Alice (alice@example.com)" — names the person in the confirm dialog. */
  userLabel: string;
  status: string | null;
  suspendedReason: string | null;
  suspendedAt: string | null;
  canModerate: boolean;
  /** When set, suspending is blocked (self / last admin); shown and disables the button. */
  blockedReason: string | null;
}

export default function MemberModeration({
  userId,
  userLabel,
  status,
  suspendedReason,
  suspendedAt,
  canModerate,
  blockedReason,
}: MemberModerationProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function runSuspend() {
    setError(null);
    startTransition(async () => {
      const res = await suspendMemberAction(userId, reason);
      if (res.ok) {
        setConfirmOpen(false);
        setReason("");
        router.refresh();
      } else {
        setError(res.error ?? "Couldn't suspend this member.");
      }
    });
  }

  function runUnsuspend() {
    setError(null);
    startTransition(async () => {
      const res = await unsuspendMemberAction(userId);
      if (res.ok) router.refresh();
      else setError(res.error ?? "Couldn't lift the suspension.");
    });
  }

  if (status === "suspended") {
    return (
      <div className="rounded-xl border border-danger/40 bg-danger/10 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-display text-[14px] font-bold text-danger">
              Account suspended
            </div>
            <p className="mt-0.5 text-[12px] text-muted">
              {suspendedReason
                ? `Reason: ${suspendedReason}`
                : "No reason recorded."}
              {suspendedAt ? ` · ${suspendedAt.slice(0, 10)}` : ""}
            </p>
          </div>
          {canModerate && (
            <button
              type="button"
              onClick={runUnsuspend}
              disabled={pending}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] text-ink transition-colors hover:border-accent disabled:opacity-60"
            >
              {pending ? "Lifting…" : "Lift suspension"}
            </button>
          )}
        </div>
        {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
      </div>
    );
  }

  // Active account: only moderators see the suspend control.
  if (!canModerate) return null;

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-display text-[14px] font-bold text-ink">
            Moderation
          </div>
          <p className="mt-0.5 text-[12px] text-muted">
            Suspending blocks sign-in and participation. The account and its
            data stay, and it&apos;s reversible.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirmOpen(true);
          }}
          disabled={Boolean(blockedReason)}
          title={blockedReason ?? undefined}
          className="rounded-lg border border-danger/50 px-3 py-1.5 text-[13px] text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Suspend
        </button>
      </div>
      {blockedReason && (
        <p className="mt-2 text-[12px] text-muted">{blockedReason}</p>
      )}
      {error && !confirmOpen && (
        <p className="mt-2 text-[12px] text-danger">{error}</p>
      )}

      {confirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="suspend-title"
          className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-6"
        >
          <div className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-2xl">
            <h3
              id="suspend-title"
              className="font-display text-[16px] font-bold text-ink"
            >
              Suspend {userLabel}?
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              They won&apos;t be able to sign in or take part. Their data is
              kept and you can lift this at any time.
            </p>
            <label className="mt-3 block">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                Reason (optional — emailed to the user if provided)
              </span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="e.g. repeated spam"
                className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
              />
            </label>
            {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={runSuspend}
                disabled={pending}
                className="flex-1 rounded-lg border border-danger bg-danger/15 px-4 py-2 font-semibold text-danger transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {pending ? "Suspending…" : "Suspend"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmOpen(false);
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
