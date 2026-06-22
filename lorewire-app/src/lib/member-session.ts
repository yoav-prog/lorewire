// Public-user session resolved against the DB. This is the enforcement point
// for suspension on the public side.
//
// The lw_user cookie is a stateless 7-day JWT (src/lib/user-session.ts) and
// cannot be revoked. readUserSession() only verifies the signature, so a
// suspended — or deleted — account would otherwise keep acting as itself until
// the token expired. readActiveUserSession() re-reads the user row each call
// and returns the session only while the account is active, so a status change
// takes effect on the very next request.
//
// Use this on PARTICIPATION paths (profile edit, avatar upload, and any future
// write a suspended user must not perform). Do NOT use it on GDPR self-service
// (export / delete): suspension must never block a user's right to access or
// erase their own data, so those paths stay on the raw readUserSession().
//
// Kept separate from user-session.ts on purpose: that module is intentionally
// DB-free (pure jose + cookies) and is stubbed in several tests; the DB read
// lives here so that separation holds.
//
// Plan: _plans/2026-06-22-admin-user-management.md (Phase 3).

import "server-only";

import { readUserSession, type UserSessionData } from "@/lib/user-session";
import { getUserById, isSuspended } from "@/lib/users";

export async function readActiveUserSession(): Promise<UserSessionData | null> {
  const session = await readUserSession();
  if (!session) return null;
  const user = await getUserById(session.userId);
  if (!user || isSuspended(user.status)) return null;
  return session;
}
