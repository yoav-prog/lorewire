// Microsoft Entra ID (formerly Azure AD) OAuth 2.0 + OIDC. Parallel to
// oauth-google.ts in shape — different provider, same security obligations.
//
// Tenant choice: we use `common` (multi-tenant) so personal accounts AND
// work/school accounts can both sign in. The downside is the `iss` claim
// in returned id_tokens varies per account type:
//   - personal accounts → https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0
//   - work/school       → https://login.microsoftonline.com/{tenant_id}/v2.0
// The single-string issuer check that jose accepts won't match both. We
// therefore verify the issuer pattern manually after jose handles signature
// + exp + aud, instead of letting jose enforce a fixed issuer.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §Sign-in flow.

import "server-only";
import * as arctic from "arctic";
import { createRemoteJWKSet, jwtVerify } from "jose";

const MS_TENANT_DEFAULT = "common";
const MS_JWKS_URL =
  "https://login.microsoftonline.com/common/discovery/v2.0/keys";
// Issuer pattern we accept. Anchored so a token whose iss merely
// CONTAINS the prefix can't slip through; the {tenantGuid} segment is
// either a GUID or 'consumers'/'organizations'.
const MS_ISSUER_RE =
  /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{8,}\/v2\.0$/;

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function jwks() {
  if (!cachedJwks) {
    cachedJwks = createRemoteJWKSet(new URL(MS_JWKS_URL));
  }
  return cachedJwks;
}

export interface MicrosoftConfig {
  clientId: string;
  clientSecret: string;
  tenant: string;
  redirectUri: string;
}

export function readMicrosoftConfig(): MicrosoftConfig | null {
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const tenant = process.env.MICROSOFT_TENANT?.trim() || MS_TENANT_DEFAULT;
  const origin = process.env.NEXT_PUBLIC_SITE_ORIGIN?.trim();
  if (!origin) {
    throw new Error(
      "NEXT_PUBLIC_SITE_ORIGIN must be set to construct the Microsoft redirect URI",
    );
  }
  const redirectUri = `${origin.replace(/\/$/, "")}/auth/microsoft/callback`;
  return { clientId, clientSecret, tenant, redirectUri };
}

export function buildMicrosoftClient(): arctic.MicrosoftEntraId | null {
  const cfg = readMicrosoftConfig();
  if (!cfg) return null;
  return new arctic.MicrosoftEntraId(
    cfg.tenant,
    cfg.clientId,
    cfg.clientSecret,
    cfg.redirectUri,
  );
}

export interface MicrosoftIdClaims {
  /** Microsoft's `oid` is the stable per-user GUID; we use it as the
   *  provider_sub equivalent. The `sub` claim is per-app and would
   *  break cross-app correlation, so we DON'T use it. */
  oid: string;
  email: string;
  name: string | null;
}

/** Verify a Microsoft Entra id_token. Same throw-on-failure shape as
 *  oauth-google.ts:verifyGoogleIdToken. */
export async function verifyMicrosoftIdToken(
  idToken: string,
  expectedAudience: string,
): Promise<MicrosoftIdClaims> {
  const { payload } = await jwtVerify(idToken, jwks(), {
    audience: expectedAudience,
    // issuer left to manual check below (multi-tenant `common` issues
    // tokens from per-tenant URLs; jose can't match a regex).
  });
  const iss = typeof payload.iss === "string" ? payload.iss : "";
  if (!MS_ISSUER_RE.test(iss)) {
    throw new Error(`Microsoft id_token iss not accepted: ${iss}`);
  }
  const oid = typeof payload.oid === "string" ? payload.oid : "";
  if (!oid) throw new Error("Microsoft id_token missing oid");
  // Email surface varies per account type: work/school usually fills
  // `email`, personal accounts use `preferred_username` for an email-
  // shaped value. Walk both, return the first that looks valid.
  let email = typeof payload.email === "string" ? payload.email : "";
  if (!email && typeof payload.preferred_username === "string") {
    email = payload.preferred_username;
  }
  if (!email || !email.includes("@")) {
    throw new Error("Microsoft id_token missing or malformed email");
  }
  const name = typeof payload.name === "string" ? payload.name : null;
  return { oid, email, name };
}
