"use client";

// Team management controls (staff with team.manage): invite a new staff member
// by email + role, and revoke pending invites. The invite link is shown back
// to the inviter once so they can copy it even when email isn't configured —
// the raw token isn't stored, so this is the only chance to grab it.
//
// Phase 5 of _plans/2026-06-22-admin-user-management.md.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { inviteStaffAction, revokeInviteAction } from "../actions";

export interface PendingInvite {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

const ROLE_OPTIONS = [
  { value: "admin", label: "Admin — full control" },
  { value: "editor", label: "Editor — content + settings" },
  { value: "moderator", label: "Moderator — members + audit" },
  { value: "viewer", label: "Viewer — read-only" },
] as const;

export default function TeamControls({ invites }: { invites: PendingInvite[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [error, setError] = useState<string | null>(null);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);

  function submitInvite() {
    setError(null);
    setCreatedLink(null);
    startTransition(async () => {
      const res = await inviteStaffAction(email.trim(), role);
      if (res.ok) {
        setEmail("");
        setCreatedLink(res.inviteUrl ?? null);
        setEmailSent(Boolean(res.emailSent));
        router.refresh();
      } else {
        setError(res.error ?? "Couldn't create the invite.");
      }
    });
  }

  function revoke(id: string) {
    startTransition(async () => {
      await revokeInviteAction(id);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <div>
        <div className="font-display text-[15px] font-bold text-ink">
          Invite a staff member
        </div>
        <p className="mt-0.5 text-[12px] text-muted">
          They&apos;ll get an email link to set a password. The role is fixed at
          invite time.
          <span className="text-muted/80">
            {" "}
            Editor, Moderator and Viewer gain studio access once the permissions
            rollout lands; Admin works today.
          </span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.com"
          aria-label="Invite email"
          className="min-w-[220px] flex-1 rounded-md border border-line bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          aria-label="Invite role"
          className="rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
        >
          {ROLE_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={submitInvite}
          disabled={pending || !email.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {pending ? "Inviting…" : "Send invite"}
        </button>
      </div>

      {error && <p className="text-[12px] text-danger">{error}</p>}

      {createdLink && (
        <div className="rounded-md border border-accent/40 bg-accent/10 p-3 text-[12px]">
          <p className="text-ink">
            Invite created.{" "}
            {emailSent
              ? "The email is on its way."
              : "Email wasn't sent (not configured) — copy this link and share it:"}
          </p>
          <code className="mt-1 block break-all rounded bg-bg px-2 py-1 font-mono text-[11px] text-muted">
            {createdLink}
          </code>
        </div>
      )}

      {invites.length > 0 && (
        <div className="space-y-1.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Pending invites
          </div>
          <ul className="space-y-1">
            {invites.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-bg px-3 py-2 text-[12px]"
              >
                <span className="min-w-0">
                  <span className="truncate text-ink">{inv.email}</span>
                  <span className="ml-2 rounded-full border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
                    {inv.role}
                  </span>
                  <span className="ml-2 font-mono text-[10px] text-muted">
                    expires {inv.expiresAt.slice(0, 10)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => revoke(inv.id)}
                  disabled={pending}
                  className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-danger disabled:opacity-60"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
