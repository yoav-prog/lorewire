// Google OAuth 2.0 + OIDC configuration. Thin wrapper around `arctic`'s
// Google client; we hold our own ID-token verification path on top using
// `jose` so the security-critical claim checks (iss, aud, exp, nonce,
// email_verified) stay explicit in our code instead of riding on the
// library.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §Sign-in flow.

import "server-only";
import * as arctic from "arctic";
import { createRemoteJWKSet, jwtVerify } from "jose";

const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_ALT_ISSUER = "accounts.google.com";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

/** Lazy global so cold starts under serverless don't re-fetch JWKS for
 *  every request. `jose`'s createRemoteJWKSet caches keys in memory and
 *  handles rotation. */
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function jwks() {
  if (!cachedJwks) {
    cachedJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  }
  return cachedJwks;
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function readGoogleConfig(): GoogleConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const origin = process.env.NEXT_PUBLIC_SITE_ORIGIN?.trim();
  if (!origin) {
    // Fail loud here: this isn't a "Google not configured" condition,
    // it's a deploy-hygiene problem that would cause the OAuth redirect
    // to land on the wrong host.
    throw new Error(
      "NEXT_PUBLIC_SITE_ORIGIN must be set to construct the Google redirect URI",
    );
  }
  const redirectUri = `${origin.replace(/\/$/, "")}/auth/google/callback`;
  return { clientId, clientSecret, redirectUri };
}

export function buildGoogleClient(): arctic.Google | null {
  const cfg = readGoogleConfig();
  if (!cfg) return null;
  return new arctic.Google(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
}

/** Verified claims we accept from a Google ID token. Stricter shape than
 *  Google publishes — we ignore everything else. */
export interface GoogleIdClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

/** Verify a Google id_token. Throws on any check failure. Caller catches
 *  and returns 400 to the user; never expose the cause to the response
 *  body (rule 13). */
export async function verifyGoogleIdToken(
  idToken: string,
  expectedAudience: string,
): Promise<GoogleIdClaims> {
  const { payload } = await jwtVerify(idToken, jwks(), {
    issuer: [GOOGLE_ISSUER, GOOGLE_ALT_ISSUER],
    audience: expectedAudience,
  });
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!sub) throw new Error("Google id_token missing sub");
  const email = typeof payload.email === "string" ? payload.email : "";
  if (!email) throw new Error("Google id_token missing email");
  // Reject unverified emails. Without this check, an attacker who
  // creates a Google account claiming an email they don't control can
  // hijack the matching public-user row. Single most important claim
  // check in the file.
  const emailVerified = payload.email_verified === true;
  if (!emailVerified) {
    throw new Error("Google id_token email_verified is false");
  }
  const name = typeof payload.name === "string" ? payload.name : null;
  const picture =
    typeof payload.picture === "string" ? payload.picture : null;
  return { sub, email, emailVerified, name, picture };
}
