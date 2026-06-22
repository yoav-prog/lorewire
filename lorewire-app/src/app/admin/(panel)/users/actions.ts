"use server";

// Server actions for the admin Users area. Every action gates on a capability
// (read from the DB role), writes an append-only audit row, and — for
// suspensions — sends a best-effort notice email. Guards: you can't suspend
// your own account, and you can't suspend the last active admin (the
// authoritative check is inside suspendUser's UPDATE).
//
// Phase 3 of _plans/2026-06-22-admin-user-management.md.

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { deleteUserCompletely } from "@/lib/account-deletion";
import { audit } from "@/lib/audit";
import { isStaffRole } from "@/lib/authz";
import { requireCapability } from "@/lib/dal";
import {
  clearImpersonationCookie,
  readImpersonationClaim,
  setImpersonationCookie,
} from "@/lib/impersonation";
import {
  sendAccountDeletedEmail,
  sendAccountSuspendedEmail,
  sendStaffInviteEmail,
} from "@/lib/email";
import { createSession } from "@/lib/session";
import {
  acceptStaffInvite,
  createStaffInvite,
  revokeStaffInvite,
} from "@/lib/staff-invites";
import {
  getUserById,
  setUserRole,
  suspendUser,
  unsuspendUser,
  verifyStaffPassword,
} from "@/lib/users";
import { memberDeleteGuard } from "./guards";

export interface ModerationResult {
  ok: boolean;
  error?: string;
}

export interface InviteResult {
  ok: boolean;
  error?: string;
  /** The one-time accept link, returned so the inviter can copy it (useful when
   *  email isn't configured). Shown once; the raw token isn't stored. */
  inviteUrl?: string;
  /** Whether the notice email went out. */
  emailSent?: boolean;
}

// Absolute origin for building the invite link. Prefer the live request host
// (works in dev + prod); fall back to the configured site origin.
async function siteOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("host");
  if (host) {
    const proto = h.get("x-forwarded-proto") ?? "https";
    return `${proto}://${host}`;
  }
  return (process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "").replace(/\/$/, "");
}

// Synthetic anchor addresses (Facebook/Reddit sign-ins with no real email) end
// in `.invalid` — never try to mail those.
function isMailable(email: string | null | undefined): email is string {
  return Boolean(email && !email.toLowerCase().endsWith(".invalid"));
}

export async function suspendMemberAction(
  userId: string,
  reason: string,
): Promise<ModerationResult> {
  const session = await requireCapability("users.moderate");
  if (!userId) return { ok: false, error: "Missing user." };
  if (userId === session.userId) {
    return { ok: false, error: "You can't suspend your own account." };
  }
  const target = await getUserById(userId);
  if (!target) return { ok: false, error: "User not found." };

  const result = await suspendUser(userId, reason);
  if (result === "not_found") return { ok: false, error: "User not found." };
  if (result === "last_admin") {
    return { ok: false, error: "You can't suspend the last active admin." };
  }

  // Suspension already applied; the audit + email must not undo it, so log
  // failures loudly rather than failing the action.
  try {
    await audit({
      actorId: session.userId,
      actorEmail: session.email,
      action: "user.suspend",
      targetType: "user",
      targetId: userId,
      targetEmail: target.email,
      metadata: reason.trim() ? { reason: reason.trim() } : null,
    });
  } catch {
    // audit() already logged the failure loudly; the suspension stands.
  }

  if (isMailable(target.email)) {
    const mail = await sendAccountSuspendedEmail(target.email, reason);
    if (!mail.ok) {
      console.warn("[users action] suspend email failed", { error: mail.error });
    }
  }

  revalidatePath("/admin/users");
  revalidatePath(`/admin/users/${userId}`);
  return { ok: true };
}

export async function unsuspendMemberAction(
  userId: string,
): Promise<ModerationResult> {
  const session = await requireCapability("users.moderate");
  if (!userId) return { ok: false, error: "Missing user." };
  const target = await getUserById(userId);
  if (!target) return { ok: false, error: "User not found." };

  const ok = await unsuspendUser(userId);
  if (!ok) return { ok: false, error: "User not found." };

  try {
    await audit({
      actorId: session.userId,
      actorEmail: session.email,
      action: "user.unsuspend",
      targetType: "user",
      targetId: userId,
      targetEmail: target.email,
    });
  } catch {
    // audit() already logged loudly; the unsuspension stands.
  }

  revalidatePath("/admin/users");
  revalidatePath(`/admin/users/${userId}`);
  return { ok: true };
}

// Permanently delete a member and all their personal data (GDPR erase) via the
// shared deleteUserCompletely cascade. `confirmEmail` is the typed confirmation
// the admin entered; the guard re-checks it server-side (defense in depth with
// the UI's disabled button). An admin must be suspended before deletion — see
// memberDeleteGuard for the lockout rationale.
export async function deleteMemberAction(
  userId: string,
  confirmEmail: string,
  password: string,
): Promise<ModerationResult> {
  const session = await requireCapability("users.delete");
  if (!userId) return { ok: false, error: "Missing user." };
  const target = await getUserById(userId);
  if (!target) return { ok: false, error: "User not found." };

  const guard = memberDeleteGuard({
    isSelf: userId === session.userId,
    targetRole: target.role,
    targetStatus: target.status,
    confirmEmail,
    actualEmail: target.email,
  });
  if (!guard.ok) return { ok: false, error: guard.error };

  // Step-up re-auth: irreversible wipe — confirm the acting admin's own
  // password before proceeding (in addition to the typed-email confirmation).
  if (!(await verifyStaffPassword(session.userId, password))) {
    return { ok: false, error: "That password is incorrect." };
  }

  // Capture identity before the wipe — afterwards the row (and its email) are
  // gone, but the audit row + notice email still need them.
  const targetEmail = target.email;
  const targetProvider = target.provider;

  const result = await deleteUserCompletely(userId);
  if (!result.deletedUser) return { ok: false, error: "User not found." };

  // The wipe is irreversible and already done; audit + email must never undo
  // it, so failures are logged loudly rather than thrown.
  try {
    await audit({
      actorId: session.userId,
      actorEmail: session.email,
      action: "user.delete",
      targetType: "user",
      targetId: userId,
      targetEmail,
      metadata: targetProvider ? { provider: targetProvider } : null,
    });
  } catch {
    // audit() already logged loudly; the deletion stands.
  }

  if (isMailable(targetEmail)) {
    const mail = await sendAccountDeletedEmail(targetEmail);
    if (!mail.ok) {
      console.warn("[users action] delete email failed", { error: mail.error });
    }
  }

  revalidatePath("/admin/users");
  return { ok: true };
}

// Change a user's role (promote a member to staff, switch a staff role, or
// demote). Blocks self-change; setUserRole's guard refuses demoting the last
// active admin.
export async function changeRoleAction(
  userId: string,
  role: string,
  password: string,
): Promise<ModerationResult> {
  const session = await requireCapability("team.manage");
  if (!userId) return { ok: false, error: "Missing user." };
  if (userId === session.userId) {
    return { ok: false, error: "You can't change your own role." };
  }
  const target = await getUserById(userId);
  if (!target) return { ok: false, error: "User not found." };
  const fromRole = target.role;

  // Step-up re-auth: a role change is a privilege change, so confirm the
  // acting admin's own password before applying it.
  if (!(await verifyStaffPassword(session.userId, password))) {
    return { ok: false, error: "That password is incorrect." };
  }

  const result = await setUserRole(userId, role);
  if (result === "invalid_role") return { ok: false, error: "Invalid role." };
  if (result === "not_found") return { ok: false, error: "User not found." };
  if (result === "last_admin") {
    return { ok: false, error: "You can't demote the last active admin." };
  }

  try {
    await audit({
      actorId: session.userId,
      actorEmail: session.email,
      action: "user.role_change",
      targetType: "user",
      targetId: userId,
      targetEmail: target.email,
      metadata: { from: fromRole, to: role },
    });
  } catch {
    // audit() already logged loudly; the role change stands.
  }

  revalidatePath("/admin/users");
  revalidatePath("/admin/users/team");
  revalidatePath(`/admin/users/${userId}`);
  return { ok: true };
}

// Invite a new staff member by email. The role is bound server-side in the
// invite row; the emailed link carries a one-time token.
export async function inviteStaffAction(
  email: string,
  role: string,
): Promise<InviteResult> {
  const session = await requireCapability("team.manage");
  if (!isStaffRole(role)) return { ok: false, error: "Pick a valid role." };

  const created = await createStaffInvite({
    email,
    role,
    invitedBy: session.userId,
  });
  if (!created.ok) return { ok: false, error: created.error };

  const inviteUrl = `${await siteOrigin()}/admin/invite/${created.token}`;

  try {
    await audit({
      actorId: session.userId,
      actorEmail: session.email,
      action: "team.invite_create",
      targetType: "invite",
      targetId: created.id,
      targetEmail: email,
      metadata: { role },
    });
  } catch {
    // audit() already logged loudly; the invite stands.
  }

  const mail = await sendStaffInviteEmail(email, inviteUrl, role);
  if (!mail.ok) {
    console.warn("[users action] invite email failed", { error: mail.error });
  }

  revalidatePath("/admin/users/team");
  // Return the link so the inviter can copy it (covers email-not-configured).
  return { ok: true, inviteUrl, emailSent: mail.ok };
}

export async function revokeInviteAction(
  inviteId: string,
): Promise<ModerationResult> {
  const session = await requireCapability("team.manage");
  if (!inviteId) return { ok: false, error: "Missing invite." };
  const revoked = await revokeStaffInvite(inviteId);
  if (!revoked) {
    return { ok: false, error: "That invite was already used or revoked." };
  }
  try {
    await audit({
      actorId: session.userId,
      actorEmail: session.email,
      action: "team.invite_revoke",
      targetType: "invite",
      targetId: inviteId,
    });
  } catch {
    // audit() already logged loudly; the revoke stands.
  }
  revalidatePath("/admin/users/team");
  return { ok: true };
}

// Accept an invite: set a password, create the staff account, sign in. Gated by
// the one-time token (not a capability) — the invitee isn't staff yet.
export async function acceptInviteAction(
  token: string,
  password: string,
): Promise<ModerationResult> {
  const result = await acceptStaffInvite(token, password);
  if (!result.ok) return { ok: false, error: result.error };

  const user = await getUserById(result.userId);
  try {
    await audit({
      actorId: result.userId,
      actorEmail: user?.email ?? null,
      action: "team.invite_accept",
      targetType: "user",
      targetId: result.userId,
      targetEmail: user?.email ?? null,
      metadata: user?.role ? { role: user.role } : null,
    });
  } catch {
    // audit() already logged loudly; the account exists.
  }

  if (user) {
    await createSession({ userId: user.id, email: user.email, role: user.role });
  }
  return { ok: true };
}

// Start "view as member": mint the impersonation cookie after re-auth. Refuses
// self and any staff target (members only). The admin's lw_session is
// untouched; this only overlays the public reader.
export async function startImpersonationAction(
  targetId: string,
  password: string,
): Promise<ModerationResult> {
  const session = await requireCapability("users.impersonate");
  if (!targetId) return { ok: false, error: "Missing user." };
  if (targetId === session.userId) {
    return { ok: false, error: "You can't view as your own account." };
  }
  const target = await getUserById(targetId);
  if (!target) return { ok: false, error: "User not found." };
  if (target.role !== "user") {
    return { ok: false, error: "You can only view as a member, not a staff account." };
  }
  // Step-up re-auth before assuming someone else's view.
  if (!(await verifyStaffPassword(session.userId, password))) {
    return { ok: false, error: "That password is incorrect." };
  }

  await setImpersonationCookie({ actorId: session.userId, targetId });
  try {
    await audit({
      actorId: session.userId,
      actorEmail: session.email,
      action: "user.impersonate_start",
      targetType: "user",
      targetId,
      targetEmail: target.email,
    });
  } catch {
    // audit() already logged loudly; impersonation still started.
  }
  return { ok: true };
}

// Stop impersonating — clear the cookie + audit. No capability gate: clearing
// your own (possibly stale) impersonation is always allowed. Called from the
// banner's Exit form, so it redirects back into the admin afterwards.
export async function stopImpersonationAction(): Promise<void> {
  const claim = await readImpersonationClaim();
  await clearImpersonationCookie();
  if (claim) {
    try {
      const target = await getUserById(claim.targetId);
      await audit({
        actorId: claim.actorId,
        action: "user.impersonate_stop",
        targetType: "user",
        targetId: claim.targetId,
        targetEmail: target?.email ?? null,
      });
    } catch {
      // audit() already logged loudly; the cookie is cleared regardless.
    }
    redirect(`/admin/users/${claim.targetId}`);
  }
  redirect("/admin/users");
}
