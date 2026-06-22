// Admin "view as member" (impersonation) — the riskiest piece, so the design
// is deliberately conservative:
//
//   - A SEPARATE cookie (lw_impersonate), never the admin lw_session or a
//     member lw_user. The admin's real session is untouched, so every admin
//     gate (requireCapability, reading lw_session) still sees the ADMIN — there
//     is no privilege laundering.
//   - It overlays ONLY the public reader's personalization (who the homepage
//     renders for). It grants NO write power: public writes use
//     readActiveUserSession (the lw_user cookie), which the admin doesn't have,
//     so write-as-target is impossible by construction.
//   - Time-boxed (30 min) and re-validated every request: resolveImpersonation
//     re-reads the actor from the DB and only honors the cookie while the actor
//     still holds users.impersonate and isn't suspended. Revoking the role (or
//     suspending the actor) ends impersonation on the next request.
//   - Bulletproof: resolveImpersonation swallows every error and returns null,
//     so it can never break a public page.
//
// Signed with SESSION_SECRET (impersonation is an admin-initiated, admin-scoped
// artifact — same trust domain as lw_session).
//
// Plan: _plans/2026-06-22-admin-user-management.md (Phase 7).

import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

import { hasCapability } from "@/lib/authz";
import { getUserById } from "@/lib/users";

export const IMPERSONATE_COOKIE = "lw_impersonate";
const ALG = "HS256";
const TTL_MIN = 30;

function key(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export interface ImpersonationClaim {
  actorId: string;
  targetId: string;
}

export async function setImpersonationCookie(
  claim: ImpersonationClaim,
): Promise<void> {
  const token = await new SignJWT({ ...claim })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${TTL_MIN}m`)
    .sign(key());
  const store = await cookies();
  store.set(IMPERSONATE_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(Date.now() + TTL_MIN * 60 * 1000),
  });
}

export async function clearImpersonationCookie(): Promise<void> {
  const store = await cookies();
  store.delete(IMPERSONATE_COOKIE);
}

// Raw claim straight from the verified cookie — NO capability re-check. Used by
// the stop path (you can always clear your own stale cookie) and the audit on
// stop. Returns null on a missing/invalid/expired cookie.
export async function readImpersonationClaim(): Promise<ImpersonationClaim | null> {
  try {
    const store = await cookies();
    const token = store.get(IMPERSONATE_COOKIE)?.value;
    if (!token) return null;
    const { payload } = await jwtVerify(token, key(), { algorithms: [ALG] });
    if (
      typeof payload.actorId === "string" &&
      typeof payload.targetId === "string"
    ) {
      return { actorId: payload.actorId, targetId: payload.targetId };
    }
    return null;
  } catch {
    return null;
  }
}

// Authoritative resolver for the reader/banner: a valid cookie AND the actor
// still holds users.impersonate AND isn't suspended (re-checked from the DB
// each call — the revocation point). Any error → null, so a public page never
// breaks because of impersonation.
export async function resolveImpersonation(): Promise<ImpersonationClaim | null> {
  try {
    const claim = await readImpersonationClaim();
    if (!claim) return null;
    const actor = await getUserById(claim.actorId);
    if (!actor || actor.status === "suspended") return null;
    if (!hasCapability(actor.role, "users.impersonate")) return null;
    return claim;
  } catch {
    return null;
  }
}
