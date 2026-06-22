// Admin → Users → member detail. Read-only profile + activity + the admin
// audit trail for one account. Reached from the Members list; deep-linkable.
//
// Phase 2 of _plans/2026-06-22-admin-user-management.md. Per-user actions
// (suspend / delete / impersonate / role) attach to this page in later phases.

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentUser, requireCapability } from "@/lib/dal";
import { hasCapability } from "@/lib/authz";
import {
  countActiveAdmins,
  getMemberActivity,
  getUserById,
  isSuspended,
} from "@/lib/users";
import { listAuditForTarget, parseAuditMetadata } from "@/lib/audit";
import {
  PROVIDER_LABEL,
  avatarTone,
  fmtDate,
  memberInitials,
} from "../member-display";
import MemberModeration from "../MemberModeration";
import MemberDelete from "../MemberDelete";
import MemberRole from "../MemberRole";
import MemberImpersonate from "../MemberImpersonate";

export const dynamic = "force-dynamic";

// ISO-8601 → "2026-06-22 14:05" (locale-free, minute precision) for the audit
// timeline, where the time of day matters.
function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function roleLabel(role: string): string {
  return role === "user" ? "Member" : role[0].toUpperCase() + role.slice(1);
}

export default async function MemberDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireCapability("users.view");
  const { id } = await params;
  const user = await getUserById(id);
  if (!user) notFound();

  const viewer = await currentUser();
  const canModerate = hasCapability(viewer?.role, "users.moderate");
  const canDelete = hasCapability(viewer?.role, "users.delete");
  const canManageTeam = hasCapability(viewer?.role, "team.manage");
  const canImpersonate = hasCapability(viewer?.role, "users.impersonate");

  const isSelf = session.userId === user.id;
  // Only pay for the admin count when it can matter.
  const onlyAdmin =
    user.role === "admin" && (await countActiveAdmins()) <= 1;

  // Why each destructive control might be blocked, shown as a tooltip + note.
  // The server enforces the same guards regardless; this is just honest UX.
  let suspendBlockedReason: string | null = null;
  if (isSelf) {
    suspendBlockedReason = "You can't suspend your own account.";
  } else if (onlyAdmin) {
    suspendBlockedReason =
      "This is the only active admin — suspending it would lock everyone out.";
  }

  let deleteBlockedReason: string | null = null;
  if (isSelf) {
    deleteBlockedReason = "You can't delete your own account.";
  } else if (user.role === "admin" && !isSuspended(user.status)) {
    deleteBlockedReason =
      "Suspend this admin before deleting it (a safety step against lockout).";
  }

  let roleBlockedReason: string | null = null;
  if (isSelf) {
    roleBlockedReason = "You can't change your own role.";
  } else if (onlyAdmin) {
    roleBlockedReason =
      "This is the only active admin — promote another before changing this role.";
  }

  let impersonateBlockedReason: string | null = null;
  if (isSelf) {
    impersonateBlockedReason = "You can't view as your own account.";
  } else if (user.role !== "user") {
    impersonateBlockedReason = "View as is for members, not staff accounts.";
  }

  const [activity, auditTrail] = await Promise.all([
    getMemberActivity(user.id),
    listAuditForTarget("user", user.id),
  ]);

  const stats: Array<{ label: string; value: number }> = [
    { label: "Saves", value: activity.saves },
    { label: "Likes", value: activity.likes },
    { label: "Fav categories", value: activity.favCategories },
    { label: "Recently viewed", value: activity.recentlyViewed },
    { label: "Continue", value: activity.continueItems },
    { label: "Poll votes", value: activity.pollVotes },
  ];

  return (
    <div className="space-y-5">
      <Link
        href="/admin/users"
        className="inline-block font-mono text-[11px] uppercase tracking-wider text-muted hover:text-ink"
      >
        ← Users
      </Link>

      {/* Profile */}
      <div className="flex items-start gap-4 rounded-xl border border-line bg-surface p-5">
        <span
          className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full font-display text-[18px] font-bold ${avatarTone(
            user.id,
          )}`}
        >
          {memberInitials(user.name, user.email)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-[20px] font-extrabold tracking-tightest">
              {user.name?.trim() || "(no name)"}
            </h1>
            <span className="rounded-full border border-line bg-surface2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
              {roleLabel(user.role)}
            </span>
          </div>
          <p className="mt-0.5 break-all font-mono text-[12px] text-muted">
            {user.email}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-4">
            <Field label="Provider">
              {user.provider
                ? PROVIDER_LABEL[user.provider] ?? user.provider
                : "—"}
            </Field>
            <Field label="Joined">{fmtDate(user.created_at)}</Field>
            <Field label="Last seen">{fmtDate(user.last_seen_at)}</Field>
            <Field label="Origin">
              {user.anonymous_id ? "Stitched from anon" : "Direct sign-up"}
            </Field>
          </dl>
        </div>
      </div>

      {/* Role — staff with team.manage can promote/demote. */}
      <MemberRole
        userId={user.id}
        currentRole={user.role}
        canManage={canManageTeam}
        blockedReason={roleBlockedReason}
      />

      {/* Moderation — suspended banner for everyone; suspend control for
          users.moderate. */}
      <MemberModeration
        userId={user.id}
        userLabel={`${user.name?.trim() || "(no name)"} (${user.email})`}
        status={user.status}
        suspendedReason={user.suspended_reason}
        suspendedAt={user.suspended_at}
        canModerate={canModerate}
        blockedReason={suspendBlockedReason}
      />

      <MemberImpersonate
        targetId={user.id}
        targetLabel={`${user.name?.trim() || "(no name)"} (${user.email})`}
        canImpersonate={canImpersonate}
        blockedReason={impersonateBlockedReason}
      />

      <MemberDelete
        userId={user.id}
        userEmail={user.email}
        userLabel={`${user.name?.trim() || "(no name)"} (${user.email})`}
        canDelete={canDelete}
        blockedReason={deleteBlockedReason}
      />

      {/* Activity */}
      <section>
        <h2 className="mb-2 font-display text-[15px] font-bold text-ink">
          Activity
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {stats.map((s) => (
            <div
              key={s.label}
              className="rounded-lg border border-line bg-surface px-3 py-2.5"
            >
              <div className="font-display text-[20px] font-bold text-ink">
                {s.value.toLocaleString()}
              </div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Admin audit trail for this member */}
      <section>
        <h2 className="mb-2 font-display text-[15px] font-bold text-ink">
          Admin actions
        </h2>
        {auditTrail.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-[12px] text-muted">
            No admin actions have been recorded for this member yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {auditTrail.map((row) => {
              const meta = parseAuditMetadata(row);
              const metaPairs = Object.entries(meta);
              return (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2 text-[12px]"
                >
                  <span className="rounded bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-ink">
                    {row.action}
                  </span>
                  <span className="font-mono text-[11px] text-muted">
                    {fmtDateTime(row.created_at)}
                  </span>
                  {metaPairs.length > 0 && (
                    <span className="font-mono text-[11px] text-muted">
                      {metaPairs
                        .map(([k, v]) => `${k}: ${String(v)}`)
                        .join(" · ")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-wider text-muted">
        {label}
      </dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}
