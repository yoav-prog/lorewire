// Server-side cookie-consent helpers. Pair with src/lib/consent-client.ts
// for the browser-side state store.
//
// Source-of-truth model: the `lw_consent` cookie is canonical. It's NOT
// HttpOnly — the client reads it directly via document.cookie so the UI
// can branch on consent without a server round-trip every render. The
// (server-mirrored) localStorage flag is a fast-path cache only; if it
// disagrees with the cookie, the cookie wins.
//
// Lifecycle:
//   accepted → lw_anon is also issued (the identity stitch primitive)
//   rejected → lw_anon is explicitly cleared (the device asked us not to
//              persist identity); existing localStorage on the client gets
//              cleared by the client store on the same response.
//
// Why store consent as a cookie and not a session column: anonymous users
// don't have a session row; the cookie is the only durable handle we have
// before sign-in. After sign-in, consent is implicit (the user signed up,
// they consented to persisted state), so the cookie just stays consistent.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §Cookie consent.

import "server-only";
import { cookies } from "next/headers";
import { clearAnonToken, getOrIssueAnonToken } from "@/lib/anon";

export const CONSENT_COOKIE = "lw_consent";
export type ConsentValue = "accepted" | "rejected";

const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Read the cookie. Returns null when unset OR when the value isn't one of
 *  the two known states (defensive: a bad cookie shouldn't trip the
 *  client into thinking it's been decided). */
export async function readConsent(): Promise<ConsentValue | null> {
  const store = await cookies();
  const raw = store.get(CONSENT_COOKIE)?.value;
  if (raw === "accepted" || raw === "rejected") return raw;
  return null;
}

/** Set the cookie + manage the paired anon identity. Returns the issued
 *  anon token on accept, or null on reject. Idempotent within a request. */
export async function setConsent(
  value: ConsentValue,
): Promise<{ value: ConsentValue; anonToken: string | null }> {
  const store = await cookies();
  // Non-HttpOnly: client reads this directly. No secret material lives
  // here; the value is one of two known constants.
  store.set(CONSENT_COOKIE, value, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  if (value === "accepted") {
    const anonToken = await getOrIssueAnonToken();
    return { value, anonToken };
  }
  await clearAnonToken();
  return { value, anonToken: null };
}
