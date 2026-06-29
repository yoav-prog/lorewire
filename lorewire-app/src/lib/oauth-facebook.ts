// Facebook OAuth 2.0. Closest sibling to the Reddit provider, with the same
// three deviations from the Google/Microsoft OIDC path plus one Facebook
// quirk:
//
//   1. NO PKCE. arctic's Facebook client takes (state, scopes) in
//      createAuthorizationURL — no codeVerifier. State alone defends the
//      round-trip, same as Reddit.
//
//   2. NO id_token. Facebook Login isn't OIDC here; the token exchange
//      yields an access_token and identity comes from a separate GET to the
//      Graph API /me endpoint with the bearer token in the query string.
//
//   3. EMAIL IS OPTIONAL. A user can deny the `email` scope or have a
//      phone-only account, so /me may omit it. Facebook only ever returns a
//      CONFIRMED email, so when one is present we treat it as verified and
//      let it flow through the normal cross-provider merge (the squatter
//      guard in users.ts still applies unchanged). When it's absent we
//      synthesize one in the RFC-6761 reserved `.invalid` TLD —
//          <facebook_id>@facebook.user.lorewire.invalid
//      — exactly like the Reddit provider, so the row anchors to itself and
//      never merges by a colliding email.
//
//   4. arctic's Facebook validateAuthorizationCode does NOT throw
//      arctic.OAuth2RequestError (Facebook's error responses are non-RFC).
//      The callback handles a plain rejected promise, so it must not copy
//      Reddit's `instanceof OAuth2RequestError` branch.
//
// Credentials: ONE Meta app serves both Facebook Login and the (planned)
// shorts publisher + the data-deletion callback. The client secret is the
// Meta App Secret, read from META_APP_SECRET — the SAME value the
// data-deletion callback verifies signed_requests against. We deliberately
// do NOT introduce a separate FACEBOOK_CLIENT_SECRET env: if the login
// secret and the deletion-verifier secret ever drifted, HMAC verification of
// a login user's deletion request would silently fail and we'd no-op a
// deletion we promised Meta we'd honor. FACEBOOK_CLIENT_ID is the (non-secret)
// Meta App ID.
//
// Plan: _plans/2026-06-22-facebook-login-and-data-deletion.md §A.

import "server-only";
import * as arctic from "arctic";

import { normalizeEmail } from "@/lib/users";

const FACEBOOK_ME_URL = "https://graph.facebook.com/me";

export interface FacebookConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function readFacebookConfig(): FacebookConfig | null {
  const clientId = process.env.FACEBOOK_CLIENT_ID?.trim();
  // Shared with the data-deletion callback verifier — see module header.
  const clientSecret = process.env.META_APP_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const origin = process.env.NEXT_PUBLIC_SITE_ORIGIN?.trim();
  if (!origin) {
    throw new Error(
      "NEXT_PUBLIC_SITE_ORIGIN must be set to construct the Facebook redirect URI",
    );
  }
  const redirectUri = `${origin.replace(/\/$/, "")}/auth/facebook/callback`;
  return { clientId, clientSecret, redirectUri };
}

export function buildFacebookClient(): arctic.Facebook | null {
  const cfg = readFacebookConfig();
  if (!cfg) return null;
  return new arctic.Facebook(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
}

/** Graph API /me payload, narrowed to the fields we request. `picture` is an
 *  object ({ data: { url, ... } }), not a flat string — Facebook wraps it. */
interface FacebookMeResponse {
  id?: unknown;
  name?: unknown;
  email?: unknown;
  picture?: { data?: { url?: unknown } };
}

export interface FacebookIdentity {
  /** Facebook's app-scoped user id. Stable per Meta app and identical to the
   *  `user_id` that arrives in the data-deletion signed_request, which is how
   *  that callback finds the row to delete. Stored as provider_sub. */
  facebookId: string;
  name: string | null;
  /** Real confirmed email when Facebook returned one, else a synthetic
   *  `.invalid` anchor. Always non-empty so the users.ts model (which keys on
   *  email) has something to store. */
  email: string;
  /** True when `email` is a real Facebook-confirmed address (merge-eligible),
   *  false when it's the synthetic anchor. For logging only. */
  hasRealEmail: boolean;
  pictureUrl: string | null;
}

/** Resolve the parsed /me JSON into our identity shape. Pure (no I/O) so the
 *  email-fallback branch is easy to reason about. Throws when the required
 *  `id` is missing. */
export function toFacebookIdentity(payload: FacebookMeResponse): FacebookIdentity {
  const facebookId = typeof payload.id === "string" ? payload.id : "";
  if (!facebookId) throw new Error("Facebook /me missing id");

  const name =
    typeof payload.name === "string" && payload.name.trim()
      ? payload.name.trim()
      : null;

  const rawEmail =
    typeof payload.email === "string" ? normalizeEmail(payload.email) : "";
  const hasRealEmail = rawEmail.length > 0 && rawEmail.includes("@");
  const email = hasRealEmail
    ? rawEmail
    : `${facebookId}@facebook.user.lorewire.invalid`;

  const pictureRaw = payload.picture?.data?.url;
  const pictureUrl =
    typeof pictureRaw === "string" && pictureRaw.trim() ? pictureRaw.trim() : null;

  return { facebookId, name, email, hasRealEmail, pictureUrl };
}

/** Fetch the signed-in Facebook user's identity. Throws on transport failure,
 *  non-OK status, or missing id. The callback catches and maps to a generic
 *  failure — never expose the raw cause to the user. */
export async function fetchFacebookIdentity(
  accessToken: string,
): Promise<FacebookIdentity> {
  // Unversioned endpoint (matches arctic's documented example); maps to the
  // app's lowest available Graph version, which serves id/name/email/picture
  // identically. Pin a version here if Meta deprecates the unversioned path.
  const params = new URLSearchParams({
    access_token: accessToken,
    fields: "id,name,email,picture",
  });
  const res = await fetch(`${FACEBOOK_ME_URL}?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Facebook /me returned ${res.status}`);
  }
  const payload = (await res.json()) as FacebookMeResponse;
  return toFacebookIdentity(payload);
}
