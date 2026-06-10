// Stateless session: a signed JWT (jose) in an httpOnly cookie. The payload
// holds only the minimum identity needed for authorization, never PII or
// secrets. SESSION_SECRET signs it.

import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "lw_session";
const ALG = "HS256";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function key(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export interface SessionData {
  userId: string;
  email: string;
  role: string;
}

export async function encrypt(data: SessionData): Promise<string> {
  return new SignJWT({ ...data })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(key());
}

export async function decrypt(token?: string): Promise<SessionData | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: [ALG] });
    if (
      typeof payload.userId === "string" &&
      typeof payload.email === "string" &&
      typeof payload.role === "string"
    ) {
      return { userId: payload.userId, email: payload.email, role: payload.role };
    }
    return null;
  } catch {
    return null;
  }
}

export async function createSession(data: SessionData): Promise<void> {
  const token = await encrypt(data);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(Date.now() + MAX_AGE_MS),
  });
}

export async function readSession(): Promise<SessionData | null> {
  const cookieStore = await cookies();
  return decrypt(cookieStore.get(SESSION_COOKIE)?.value);
}

export async function deleteSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}
