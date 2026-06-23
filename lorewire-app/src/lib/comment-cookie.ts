// Anonymous comment token. Same primitive as the poll vote cookie
// (src/lib/poll-cookie.ts): a 256-bit random nonce, NOT a signed JWT, because
// its only jobs are anti-double-like and "let this browser see its own held or
// rejected comment". No identity rides on it, so signing would be ceremony.
//
// Security (rule 13): HttpOnly so client JS can't read it, Secure in prod,
// SameSite=Lax so a first comment works when the user lands from an external
// referral. 365-day TTL so a returning guest keeps the same anchor.

import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";

export const COMMENT_COOKIE = "lw_comment";
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

function newToken(): string {
  return randomBytes(32).toString("hex");
}

/** Read the existing comment token without issuing one. Used by the public
 *  read path to decide which non-published comments (the viewer's own) to
 *  include, without forcing a Set-Cookie on every cold SSR visit. */
export async function readCommentToken(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(COMMENT_COOKIE)?.value;
  return value && value.length > 0 ? value : null;
}

/** Read the existing token OR issue + set a new one. Call from the POST route
 *  handler where a Set-Cookie response is honored; the fresh token is returned
 *  so the insert can use it on the same request. */
export async function getOrIssueCommentToken(): Promise<string> {
  const existing = await readCommentToken();
  if (existing) return existing;
  const token = newToken();
  const store = await cookies();
  store.set(COMMENT_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return token;
}
