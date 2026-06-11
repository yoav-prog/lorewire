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

export const getSession = cache(async (): Promise<SessionData | null> => {
  return readSession();
});

// Per-request memoization of the DB user lookup. The panel layout calls
// requireAdmin(), then each page calls requireAdmin() again, and currentUser()
// re-asks. Without cache() each navigation paid 2-3 Postgres round trips just
// to re-verify the same user.
const getUserByIdCached = cache(getUserById);

// Secure check: valid cookie AND the user still exists as an admin in the DB.
export async function requireAdmin(): Promise<SessionData> {
  const session = await getSession();
  if (!session) redirect("/admin/login");
  const user = await getUserByIdCached(session.userId);
  if (!user || user.role !== "admin") redirect("/admin/login");
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
