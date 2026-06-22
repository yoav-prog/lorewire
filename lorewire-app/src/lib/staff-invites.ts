// Staff invites — email-based onboarding for new admin/editor/moderator/viewer
// accounts. An admin issues an invite bound to an email + role; the invitee
// clicks the emailed link and sets their own password, which creates the staff
// row with the role the inviter chose.
//
// Security:
//   - The raw token lives ONLY in the emailed URL. We store its SHA-256 hash,
//     so a DB leak can't be used to accept an invite (same as magic links).
//   - The role is bound in the DB row at invite time and NEVER read from the
//     client at accept — a leaked link can only grant the role the inviter
//     picked, not escalate to admin.
//   - Single-use: accept atomically claims accepted_at (WHERE accepted_at IS
//     NULL) and re-reads a unique marker to confirm it won the race, so two
//     concurrent accepts can't both create an account.
//
// Plan: _plans/2026-06-22-admin-user-management.md (Phase 5).

import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { all, one, run } from "@/lib/db";
import { hashPassword } from "@/lib/passwords";
import { createUser } from "@/lib/repo";
import { isStaffRole, type StaffRole } from "@/lib/authz";
import { getUserByEmail, normalizeEmail } from "@/lib/users";

export const INVITE_TTL_HOURS = 72;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

export interface StaffInviteRow {
  id: string;
  email: string;
  role: string;
  token_hash: string;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string | null;
}

const INVITE_COLS =
  "id, email, role, token_hash, invited_by, expires_at, accepted_at, revoked_at, created_at";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type CreateInviteResult =
  | { ok: true; token: string; id: string }
  | { ok: false; error: string };

// Issue an invite. Refuses if an account already exists for the email (use a
// role change instead) and supersedes any earlier pending invite to the same
// email so only the newest link works.
export async function createStaffInvite(input: {
  email: string;
  role: StaffRole;
  invitedBy: string | null;
}): Promise<CreateInviteResult> {
  const email = normalizeEmail(input.email);
  if (!email || !email.includes("@")) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (!isStaffRole(input.role)) {
    return { ok: false, error: "Pick a valid staff role." };
  }
  const existing = await getUserByEmail(email);
  if (existing) {
    return {
      ok: false,
      error: "An account already exists with this email — change their role instead.",
    };
  }
  const now = new Date();
  // Supersede earlier pending invites to the same email.
  await run(
    `UPDATE staff_invites SET revoked_at = ?
      WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
    [now.toISOString(), email],
  );
  const token = randomBytes(32).toString("hex");
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_HOURS * 3600 * 1000);
  await run(
    `INSERT INTO staff_invites
        (id, email, role, token_hash, invited_by, expires_at, accepted_at, revoked_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    [
      id,
      email,
      input.role,
      hashToken(token),
      input.invitedBy,
      expiresAt.toISOString(),
      now.toISOString(),
    ],
  );
  return { ok: true, token, id };
}

// Resolve a raw token to a usable invite, or null if it's unknown, already
// accepted, revoked, or expired.
export async function getValidInvite(
  token: string,
): Promise<StaffInviteRow | null> {
  if (!token) return null;
  const row = await one<StaffInviteRow>(
    `SELECT ${INVITE_COLS} FROM staff_invites WHERE token_hash = ?`,
    [hashToken(token)],
  );
  if (!row) return null;
  if (row.accepted_at !== null || row.revoked_at !== null) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export type AcceptInviteResult =
  | { ok: true; userId: string }
  | { ok: false; error: string };

// Accept an invite: set a password and create the staff row with the bound
// role. Atomically single-use.
export async function acceptStaffInvite(
  token: string,
  password: string,
): Promise<AcceptInviteResult> {
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    return {
      ok: false,
      error: `Password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters.`,
    };
  }
  const invite = await getValidInvite(token);
  if (!invite) {
    return { ok: false, error: "This invite link is invalid or has expired." };
  }
  if (await getUserByEmail(invite.email)) {
    return { ok: false, error: "An account with this email already exists." };
  }

  // Atomic single-use claim: mark accepted only if not already, then re-read a
  // unique marker to confirm we won (mirrors consumeMagicLink). Claiming BEFORE
  // creating the user means a lost race never creates a duplicate account.
  const marker = `${new Date().toISOString()}#${randomUUID()}`;
  await run(
    "UPDATE staff_invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL",
    [marker, invite.id],
  );
  const reread = await one<{ accepted_at: string | null }>(
    "SELECT accepted_at FROM staff_invites WHERE id = ?",
    [invite.id],
  );
  if (!reread || reread.accepted_at !== marker) {
    return { ok: false, error: "This invite was already used." };
  }

  const userId = randomUUID();
  await createUser({
    id: userId,
    email: invite.email,
    password_hash: await hashPassword(password),
    role: invite.role,
  });
  return { ok: true, userId };
}

// Pending invites for the Team UI: not yet accepted, not revoked, not expired.
export async function listStaffInvites(): Promise<StaffInviteRow[]> {
  const now = new Date().toISOString();
  return all<StaffInviteRow>(
    `SELECT ${INVITE_COLS} FROM staff_invites
      WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC`,
    [now],
  );
}

// Revoke a pending invite. Returns false if it was already accepted/revoked or
// doesn't exist.
export async function revokeStaffInvite(id: string): Promise<boolean> {
  if (!id) return false;
  await run(
    `UPDATE staff_invites SET revoked_at = ?
      WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
    [new Date().toISOString(), id],
  );
  const row = await one<{ revoked_at: string | null }>(
    "SELECT revoked_at FROM staff_invites WHERE id = ?",
    [id],
  );
  return Boolean(row?.revoked_at);
}
