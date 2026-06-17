// Anonymous vote token for the engagement-poll widget. Mirrors the
// shape of lib/session.ts but with two key differences:
//
//   1. The value is NOT a signed JWT — it's just a 256-bit random
//      nonce. The token's only job is "this browser has voted on
//      poll X" anti-double-vote; nothing about identity rides on it,
//      so signing would be ceremony without value.
//   2. The TTL is 365 days, not 7. We want the same browser's vote
//      to count once across a long tail of return visits.
//
// Security (rule 13): HttpOnly so client JS can't read or leak it,
// Secure in prod so it never travels over plaintext, SameSite=Lax so
// the vote action works when the user lands from a TikTok / Reels
// click (cross-site referral → first POST works). 256 bits of entropy
// from node:crypto's randomBytes; not predictable.
//
// Plan: _plans/2026-06-17-engagement-polls.md (§5 Public surfaces).

import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";

export const VOTE_COOKIE = "lw_vote";
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Hex-encoded 256-bit random token. */
function newToken(): string {
  return randomBytes(32).toString("hex");
}

/** Read the existing vote cookie without issuing one. Used by server
 *  components rendering the post-vote state — if there's no cookie,
 *  the widget shows the pre-vote buttons; we don't pre-issue a token
 *  just for SSR because that would force a Set-Cookie on every cold
 *  visit (and Next's RSC pipeline doesn't carry response headers
 *  through server components anyway). The token gets issued on the
 *  FIRST vote POST instead, which is when it actually matters. */
export async function readVoteToken(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(VOTE_COOKIE)?.value;
  return value && value.length > 0 ? value : null;
}

/** Read the existing token OR issue + set a new one. Call this from
 *  the /api/polls/vote route handler where a Set-Cookie response is
 *  honored. The freshly-issued token is returned so the vote insert
 *  can use it on the same request. Idempotent — calling twice in one
 *  request only sets the cookie once (Next dedupes). */
export async function getOrIssueVoteToken(): Promise<string> {
  const existing = await readVoteToken();
  if (existing) return existing;
  const token = newToken();
  const store = await cookies();
  store.set(VOTE_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return token;
}
