// Login rate limiting — brute-force defense for the admin login. DB-backed
// (the app is serverless, so an in-memory counter wouldn't hold across
// instances). Keyed by the caller — use loginAttemptKey(ip) so the stored key
// is namespaced and the IP is hashed (no raw IP at rest, rule 13).
//
// Policy: up to MAX_ATTEMPTS failures within WINDOW; the next failure locks the
// key for LOCK. A successful login clears the key. Keying by source IP (not
// account) throttles the attacker without letting someone lock a victim out of
// their own account by spamming their email.
//
// Plan: _plans/2026-06-22-admin-user-management.md (Phase 8).

import "server-only";

import { one, run } from "@/lib/db";
import { hashForLog } from "@/lib/users";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

interface AttemptRow {
  key: string;
  attempts: number;
  first_at: string;
  locked_until: string | null;
}

/** Build a stored key from a request IP: namespaced + hashed (no raw IP). */
export function loginAttemptKey(ip: string | null | undefined): string {
  return `admin-login:${hashForLog(ip || "unknown")}`;
}

export interface BlockState {
  blocked: boolean;
  retryAfterSec: number;
}

export async function isLoginBlocked(key: string): Promise<BlockState> {
  const row = await one<AttemptRow>(
    "SELECT key, attempts, first_at, locked_until FROM login_attempts WHERE key = ?",
    [key],
  );
  if (!row?.locked_until) return { blocked: false, retryAfterSec: 0 };
  const until = new Date(row.locked_until).getTime();
  const now = Date.now();
  if (until > now) {
    return { blocked: true, retryAfterSec: Math.ceil((until - now) / 1000) };
  }
  return { blocked: false, retryAfterSec: 0 };
}

export async function recordLoginFailure(key: string): Promise<void> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const row = await one<AttemptRow>(
    "SELECT key, attempts, first_at, locked_until FROM login_attempts WHERE key = ?",
    [key],
  );
  if (!row) {
    await run(
      "INSERT INTO login_attempts (key, attempts, first_at, locked_until) VALUES (?, 1, ?, NULL)",
      [key, nowIso],
    );
    return;
  }
  // Start a fresh window once the old one has elapsed AND any lock has expired.
  const windowElapsed = now - new Date(row.first_at).getTime() > WINDOW_MS;
  const lockExpired = row.locked_until
    ? new Date(row.locked_until).getTime() <= now
    : true;
  if (windowElapsed && lockExpired) {
    await run(
      "UPDATE login_attempts SET attempts = 1, first_at = ?, locked_until = NULL WHERE key = ?",
      [nowIso, key],
    );
    return;
  }
  const attempts = row.attempts + 1;
  const lockedUntil =
    attempts >= MAX_ATTEMPTS
      ? new Date(now + LOCK_MS).toISOString()
      : row.locked_until;
  await run(
    "UPDATE login_attempts SET attempts = ?, locked_until = ? WHERE key = ?",
    [attempts, lockedUntil, key],
  );
}

export async function clearLoginAttempts(key: string): Promise<void> {
  await run("DELETE FROM login_attempts WHERE key = ?", [key]);
}
