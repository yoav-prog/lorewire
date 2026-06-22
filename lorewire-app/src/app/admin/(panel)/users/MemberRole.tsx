"use client";

// Role control on the member detail page (staff with team.manage). Promote a
// member to staff, switch a staff role, or demote back to member. The server
// refuses demoting the last active admin; the UI also blocks self-change and
// notes when this is the only admin.
//
// Phase 5 of _plans/2026-06-22-admin-user-management.md.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { changeRoleAction } from "./actions";

const ROLES = [
  { value: "admin", label: "Admin" },
  { value: "editor", label: "Editor" },
  { value: "moderator", label: "Moderator" },
  { value: "viewer", label: "Viewer" },
  { value: "user", label: "Member (no studio access)" },
] as const;

interface MemberRoleProps {
  userId: string;
  currentRole: string;
  canManage: boolean;
  /** When set, role changes are blocked (self / only admin); disables the control. */
  blockedReason: string | null;
}

export default function MemberRole({
  userId,
  currentRole,
  canManage,
  blockedReason,
}: MemberRoleProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [role, setRole] = useState(currentRole);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!canManage) return null;

  const changed = role !== currentRole;

  function apply() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await changeRoleAction(userId, role, password);
      if (res.ok) {
        setSaved(true);
        setPassword("");
        router.refresh();
      } else {
        setError(res.error ?? "Couldn't change the role.");
        setRole(currentRole);
      }
    });
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-display text-[14px] font-bold text-ink">Role</div>
          <p className="mt-0.5 text-[12px] text-muted">
            Controls what this person can do in the studio.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={role}
            onChange={(e) => {
              setRole(e.target.value);
              setSaved(false);
            }}
            disabled={Boolean(blockedReason) || pending}
            aria-label="Role"
            className="rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-60"
          >
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          {changed && !blockedReason && (
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your password"
              autoComplete="current-password"
              aria-label="Confirm your password"
              className="rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
            />
          )}
          <button
            type="button"
            onClick={apply}
            disabled={!changed || Boolean(blockedReason) || pending || !password}
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-[13px] text-ink transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Saving…" : "Update role"}
          </button>
        </div>
      </div>
      {blockedReason && (
        <p className="mt-2 text-[12px] text-muted">{blockedReason}</p>
      )}
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
      {saved && !error && (
        <p className="mt-2 text-[12px] text-muted">Role updated.</p>
      )}
    </div>
  );
}
