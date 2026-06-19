// Public-user session: signed JWT in HttpOnly cookie `lw_user`.
//
// Deliberately a separate module from src/lib/session.ts (which serves
// admin staff via `lw_session`). Strict separation prevents an admin
// scope from ever leaking into a public-side helper or vice versa — the
// kind of bug that turns "user signed in" into "user has the admin
// panel". Different cookie name, different env-var secret, different
// helper, no overlap.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §Locked decisions §4.

import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

export const USER_SESSION_COOKIE = "lw_user";
const ALG = "HS256";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function key(): Uint8Array {
  const secret = process.env.USER_SESSION_SECRET;
  if (!secret) throw new Error("USER_SESSION_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export interface UserSessionData {
  userId: string;
  email: string;
  /** Closed enum at the call site: 'user' for public OAuth/magic-link
   *  users. The admin `lw_session` carries its own roles; this cookie
   *  never carries 'admin' / 'staff'. */
  role: "user";
}

export async function encryptUser(data: UserSessionData): Promise<string> {
  return new SignJWT({ ...data })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(key());
}

export async function decryptUser(
  token?: string,
): Promise<UserSessionData | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: [ALG] });
    if (
      typeof payload.userId === "string" &&
      typeof payload.email === "string" &&
      payload.role === "user"
    ) {
      return {
        userId: payload.userId,
        email: payload.email,
        role: payload.role,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function createUserSession(data: UserSessionData): Promise<void> {
  const token = await encryptUser(data);
  const store = await cookies();
  store.set(USER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(Date.now() + MAX_AGE_MS),
  });
}

export async function readUserSession(): Promise<UserSessionData | null> {
  const store = await cookies();
  return decryptUser(store.get(USER_SESSION_COOKIE)?.value);
}

export async function deleteUserSession(): Promise<void> {
  const store = await cookies();
  store.delete(USER_SESSION_COOKIE);
}
