// Data Access Layer for auth. Every admin entry point runs through here so the
// session is verified close to the data, not only in the proxy. getSession is
// memoized per request with React.cache.

import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { readSession, type SessionData } from "@/lib/session";
import { getUserById, countUsers, createUser, type UserRow } from "@/lib/repo";
import { hashPassword } from "@/lib/passwords";
import { hasCapability, isStaffRole, type Capability } from "@/lib/authz";

export const getSession = cache(async (): Promise<SessionData | null> => {
  return readSession();
});

// Per-request memoization of the DB user lookup. The panel layout calls
// requireAdmin(), then each page calls requireAdmin() again, and currentUser()
// re-asks. Without cache() each navigation paid 2-3 Postgres round trips just
// to re-verify the same user.
const getUserByIdCached = cache(getUserById);

// Secure check: valid cookie AND the user still exists as an admin in the DB
// AND is not suspended. The DB re-read each request is what lets a role or
// status change lock someone out immediately, despite the 7-day JWT.
export async function requireAdmin(): Promise<SessionData> {
  const session = await getSession();
  if (!session) redirect("/admin/login");
  const user = await getUserByIdCached(session.userId);
  if (!user || user.role !== "admin" || user.status === "suspended") {
    redirect("/admin/login");
  }
  return session;
}

// Capability gate: valid cookie AND the DB user's role grants `cap`. The
// canonical role is the DB row (via getUserByIdCached), never the cookie
// payload — a role change in the DB takes effect on the next request without
// touching the session. This generalizes requireAdmin: an "admin" row holds
// every capability, so existing admin-only pages keep working unchanged.
//
// No session → /admin/login (sign in). Signed in but lacking the capability →
// /admin (the studio home), not the login form they've already satisfied.
// Reaching that second branch requires a non-admin staff role to exist, which
// only happens once the panel layout opens to all staff (Team phase); until
// then every signed-in user is an admin and holds every capability.
export async function requireCapability(cap: Capability): Promise<SessionData> {
  const session = await getSession();
  if (!session) redirect("/admin/login");
  const user = await getUserByIdCached(session.userId);
  if (!user || user.status === "suspended") redirect("/admin/login");
  if (!hasCapability(user.role, cap)) redirect("/admin");
  return session;
}

// Panel gate: any staff role may pass (Admin / Editor / Moderator / Viewer).
// For the studio shell once non-admin staff exist; individual pages still
// narrow further via requireCapability.
export async function requireStaff(): Promise<SessionData> {
  const session = await getSession();
  if (!session) redirect("/admin/login");
  const user = await getUserByIdCached(session.userId);
  if (!user || !isStaffRole(user.role) || user.status === "suspended") {
    redirect("/admin/login");
  }
  return session;
}

export async function currentUser(): Promise<UserRow | null> {
  const session = await getSession();
  if (!session) return null;
  return getUserByIdCached(session.userId);
}

// Bootstrap the first admin from env when the users table is empty, so a fresh
// local or production install can sign in without a manual insert.
export async function ensureSeedAdmin(): Promise<void> {
  if ((await countUsers()) > 0) return;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  await createUser({
    id: randomUUID(),
    email,
    password_hash: await hashPassword(password),
    role: "admin",
  });
}
