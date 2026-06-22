"use client";

// "View as member" (support impersonation) control on the member detail page.
// Renders only for staff with users.impersonate, and only for member targets.
// Starting requires re-auth; on success we send the admin to the public
// homepage, which renders the member's personalized view with a persistent
// banner. Read-only — the admin keeps their own session and gains no write
// power as the member.
//
// Phase 7 of _plans/2026-06-22-admin-user-management.md.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { startImpersonationAction } from "./actions";

interface MemberImpersonateProps {
  targetId: string;
  targetLabel: string;
  canImpersonate: boolean;
  /** When set, view-as is blocked (self / staff target); disables the button. */
  blockedReason: string | null;
}

export default function MemberImpersonate({
  targetId,
  targetLabel,
  canImpersonate,
  blockedReason,
}: MemberImpersonateProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!canImpersonate) return null;

  function run() {
    setError(null);
    startTransition(async () => {
      const res = await startImpersonationAction(targetId, password);
      if (res.ok) {
        // Land on the public homepage to see the member's personalized view.
        router.push("/");
      } else {
        setError(res.error ?? "Couldn't start view-as.");
      }
    });
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-display text-[14px] font-bold text-ink">
            View as member (support)
          </div>
          <p className="mt-0.5 text-[12px] text-muted">
            See the site as this member sees it — their personalized homepage.
            Read-only and time-boxed; you stay signed in as yourself.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setPassword("");
            setOpen(true);
          }}
          disabled={Boolean(blockedReason)}
          title={blockedReason ?? undefined}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] text-ink transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          View as
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
          aria-labelledby="impersonate-title"
          className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-6"
        >
          <div className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-2xl">
            <h3
              id="impersonate-title"
              className="font-display text-[16px] font-bold text-ink"
            >
              View as {targetLabel}?
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              You&apos;ll see the public site personalized for this member.
              It&apos;s read-only — you can&apos;t act on their behalf —
              time-boxed, and recorded in the audit log. A banner stays up until
              you exit.
            </p>
            <label className="mt-3 block">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                Confirm your password
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
              />
            </label>
            {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={run}
                disabled={pending || !password}
                className="flex-1 rounded-lg bg-accent px-4 py-2 font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {pending ? "Starting…" : "Start view-as"}
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
