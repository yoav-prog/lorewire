// Anonymous identity cookie for public users. Mirrors lib/poll-cookie.ts in
// shape (HttpOnly + Secure + SameSite=Lax + 365-day TTL + 256-bit random
// nonce) but exists for a different purpose:
//
//   - poll-cookie's lw_vote: anti-double-vote on engagement polls, scoped
//     to the poll surface, set on first vote POST.
//   - anon's lw_anon: durable anonymous identity for this browser, set on
//     first cookie-consent accept. Phase 3 of the auth plan stitches the
//     value into the users.anonymous_id column on first OAuth sign-in so
//     server-side analytics can join anon → known without surveilling
//     anyone who never signs up.
//
// Why two cookies and not one: merging would conflate two distinct security
// properties — poll anti-replay and identity stitching — and would break
// the existing poll vote flow's ON CONFLICT(poll_id, cookie_token) primitive
// if we ever rotated the identity nonce. Cheap to keep separate.
//
// Security (rule 13): HttpOnly so client JS can't read or leak it, Secure
// in prod so it never travels over plaintext, SameSite=Lax so a cross-site
// referral (TikTok, Reels, share link) still carries identity through to
// the first server request. 256 bits of entropy from node:crypto's
// randomBytes; not predictable.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md.

import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";

export const ANON_COOKIE = "lw_anon";
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Hex-encoded 256-bit random token. Exposed for tests; production callers
 *  go through getOrIssueAnonToken below. */
export function newAnonToken(): string {
  return randomBytes(32).toString("hex");
}

/** Read the existing anonymous-identity cookie without issuing one. Used by
 *  RSC paths that want to know "does this browser already have an identity?"
 *  without forcing a Set-Cookie (server components can't emit response
 *  headers in Next 16's RSC pipeline). Returns null when the cookie is
 *  unset, empty, or malformed. */
export async function readAnonToken(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(ANON_COOKIE)?.value;
  return value && value.length > 0 ? value : null;
}

/** Read the existing token OR issue + set a new one. Call this from route
 *  handlers (POST /api/consent on Accept, POST /api/user/sync) where a
 *  Set-Cookie response is honored. The freshly-issued token is returned so
 *  the caller can immediately use it on the same request. Idempotent —
 *  calling twice in one request only sets the cookie once (Next dedupes). */
export async function getOrIssueAnonToken(): Promise<string> {
  const existing = await readAnonToken();
  if (existing) return existing;
  const token = newAnonToken();
  const store = await cookies();
  store.set(ANON_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return token;
}

/** Explicit clear, used by future account-deletion paths. Sign-out does NOT
 *  call this — the device keeps its anonymous identity after sign-out. */
export async function clearAnonToken(): Promise<void> {
  const store = await cookies();
  store.delete(ANON_COOKIE);
}
