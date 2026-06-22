"use server";

// Self-service 2FA actions for the signed-in staff member. Each operates on
// the CURRENT session's user (never an arbitrary target), so requireStaff is
// the only gate needed. Disabling 2FA requires a password re-auth.
//
// Phase 8 of _plans/2026-06-22-admin-user-management.md.

import { revalidatePath } from "next/cache";

import { requireStaff } from "@/lib/dal";
import {
  confirmMfaSetup,
  disableMfa,
  startMfaSetup,
  verifyStaffPassword,
} from "@/lib/users";

export interface StartMfaResult {
  ok: boolean;
  secret?: string;
  otpauthUri?: string;
  error?: string;
}

export async function startMfaSetupAction(): Promise<StartMfaResult> {
  const session = await requireStaff();
  const info = await startMfaSetup(session.userId);
  if (!info) return { ok: false, error: "Couldn't start setup." };
  return { ok: true, secret: info.secret, otpauthUri: info.otpauthUri };
}

export interface ConfirmMfaActionResult {
  ok: boolean;
  backupCodes?: string[];
  error?: string;
}

export async function confirmMfaSetupAction(
  code: string,
): Promise<ConfirmMfaActionResult> {
  const session = await requireStaff();
  const res = await confirmMfaSetup(session.userId, code);
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/admin/account");
  return { ok: true, backupCodes: res.backupCodes };
}

export interface DisableMfaResult {
  ok: boolean;
  error?: string;
}

export async function disableMfaAction(
  password: string,
): Promise<DisableMfaResult> {
  const session = await requireStaff();
  if (!(await verifyStaffPassword(session.userId, password))) {
    return { ok: false, error: "That password is incorrect." };
  }
  await disableMfa(session.userId);
  revalidatePath("/admin/account");
  return { ok: true };
}
