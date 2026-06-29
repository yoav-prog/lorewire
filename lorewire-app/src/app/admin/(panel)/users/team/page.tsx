// Admin → Users → Team. The staff who can sign into the studio, plus (for
// team.manage) the invite + pending-invite controls. Role changes happen on
// each member's detail page. Plan: _plans/2026-06-22-admin-user-management.md.

import Link from "next/link";

import { currentUser, requireCapability } from "@/lib/dal";
import { hasCapability } from "@/lib/authz";
import { listStaff, type UserRow } from "@/lib/users";
import { listStaffInvites } from "@/lib/staff-invites";
import UsersTabs from "../UsersTabs";
import TeamControls, { type PendingInvite } from "./TeamControls";
import { avatarTone, fmtDate, memberInitials } from "../member-display";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  editor: "Editor",
  moderator: "Moderator",
  viewer: "Viewer",
};

export default async function TeamPage() {
  await requireCapability("users.view");
  const viewer = await currentUser();
  const canManage = hasCapability(viewer?.role, "team.manage");

  const [staff, invites] = await Promise.all([
    listStaff(),
    canManage ? listStaffInvites() : Promise.resolve([]),
  ]);

  const pending: PendingInvite[] = invites.map((i) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    expiresAt: i.expires_at,
  }));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
          Users
        </h1>
        <p className="mt-1 font-mono text-[11px] text-muted">
          {staff.length} staff member{staff.length === 1 ? "" : "s"} with studio
          access.
        </p>
      </div>

      <UsersTabs active="team" />

      {canManage && <TeamControls invites={pending} />}

      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line bg-surface text-left font-mono text-[10px] uppercase tracking-wider text-muted">
              <th className="px-4 py-2.5 font-medium">Member</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((u) => (
              <StaffRow key={u.id} u={u} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StaffRow({ u }: { u: UserRow }) {
  return (
    <tr className="border-b border-line transition-colors last:border-b-0 hover:bg-surface">
      <td className="px-4 py-2.5">
        <Link
          href={`/admin/users/${encodeURIComponent(u.id)}`}
          className="flex items-center gap-3"
        >
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-bold ${avatarTone(
              u.id,
            )}`}
          >
            {memberInitials(u.name, u.email)}
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-ink hover:text-accent">
                {u.name?.trim() || "(no name)"}
              </span>
              {u.status === "suspended" && (
                <span className="shrink-0 rounded-full border border-danger/40 bg-danger/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-danger">
                  Suspended
                </span>
              )}
            </span>
            <span className="block truncate font-mono text-[11px] text-muted">
              {u.email}
            </span>
          </span>
        </Link>
      </td>
      <td className="px-4 py-2.5">
        <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent">
          {ROLE_LABEL[u.role] ?? u.role}
        </span>
      </td>
      <td className="px-4 py-2.5 font-mono text-[12px] text-muted">
        {fmtDate(u.last_seen_at)}
      </td>
    </tr>
  );
}
