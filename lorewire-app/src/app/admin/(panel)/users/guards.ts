// Pure eligibility checks for the destructive user-management actions. Kept in
// a plain module (not the "use server" actions file, where every export must be
// an async action) so the rules are unit-testable without mocking a session.
//
// Phase 4 of _plans/2026-06-22-admin-user-management.md.

export interface DeleteGuardInput {
  /** Acting admin is trying to delete their own account. */
  isSelf: boolean;
  targetRole: string;
  targetStatus: string | null;
  /** Email the admin typed into the confirm box. */
  confirmEmail: string;
  /** The target's real email. */
  actualEmail: string;
}

export type GuardResult = { ok: true } | { ok: false; error: string };

// Decide whether a member may be deleted. The order matters: self first, then
// the lockout-safety rail, then the typed-confirmation match.
//
// Admins must be SUSPENDED before deletion. That's race-safe by construction:
// suspendUser already refuses the last active admin, and a suspended admin
// doesn't count as active — so by the time an admin is deletable there is
// guaranteed to be another admin who can still sign in. Non-admins (members
// and other staff) carry no lockout risk and delete directly.
export function memberDeleteGuard(input: DeleteGuardInput): GuardResult {
  if (input.isSelf) {
    return { ok: false, error: "You can't delete your own account." };
  }
  if (input.targetRole === "admin" && input.targetStatus !== "suspended") {
    return {
      ok: false,
      error: "Suspend this admin before deleting it (a safety step against lockout).",
    };
  }
  if (
    input.confirmEmail.trim().toLowerCase() !==
    input.actualEmail.trim().toLowerCase()
  ) {
    return {
      ok: false,
      error: "The email you typed doesn't match. Deletion cancelled.",
    };
  }
  return { ok: true };
}
