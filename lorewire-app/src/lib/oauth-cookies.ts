// Short-lived HttpOnly cookies that bookkeep the OAuth round-trip. Same
// shape across providers — Google, Microsoft, future Apple. Kept here
// instead of duplicated across each route so a change in the security
// posture (e.g. SameSite) lands in one place.
//
// Cookie naming convention: `lw_oauth_{provider}_{purpose}`. The
// provider segment keeps two concurrent flows from one browser (rare
// but legitimate, e.g. user opened both Google and Microsoft buttons)
// from clobbering each other's state cookies.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §Sign-in flow.

import "server-only";

export const GOOGLE_STATE_COOKIE = "lw_oauth_g_state";
export const GOOGLE_VERIFIER_COOKIE = "lw_oauth_g_verifier";
export const MICROSOFT_STATE_COOKIE = "lw_oauth_m_state";
export const MICROSOFT_VERIFIER_COOKIE = "lw_oauth_m_verifier";
/** Reddit doesn't use PKCE so there's no verifier cookie — state alone
 *  defends the round-trip. Same TTL and HttpOnly + Secure + SameSite=Lax
 *  posture as the other providers. */
export const REDDIT_STATE_COOKIE = "lw_oauth_r_state";
/** Facebook, like Reddit, doesn't use PKCE in arctic's client — state alone
 *  defends the round-trip. */
export const FACEBOOK_STATE_COOKIE = "lw_oauth_fb_state";
/** Where to redirect after a successful sign-in. Validated through
 *  sanitizeNext on intake so a callback can't open-redirect off-site. */
export const NEXT_PATH_COOKIE = "lw_oauth_next";

const OAUTH_TTL_SECONDS = 10 * 60;

export function oauthCookieOpts() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: OAUTH_TTL_SECONDS,
  };
}

/** Accept only same-origin paths. Rejects anything with a scheme, a
 *  protocol-relative `//other.host`, a backslash trick (`/\\evil`),
 *  or characters outside a sane URL-path subset. */
export function sanitizeNext(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v) return null;
  if (!/^\/[a-zA-Z0-9_\-/.?=&%]*$/.test(v)) return null;
  // Protocol-relative protection: `//attacker.com/...` would pass the
  // regex above without this explicit guard.
  if (v.startsWith("//")) return null;
  return v;
}
