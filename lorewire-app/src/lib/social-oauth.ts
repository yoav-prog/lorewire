// Google OAuth 2.0 (authorization code + PKCE) for connecting a YouTube channel.
//
// Raw fetch against Google's endpoints, matching the house pattern (see
// _reference/youtubestudio/src/lib/google-oauth.ts and src/lib/gcs.ts). The
// google-auth-library dependency is intentionally not used so the flow stays
// explicit and auditable. On top of the reference we add PKCE (RFC 7636) and a
// DB-backed, session-bound, single-use `state` (lib/social-accounts.ts plus the
// oauth_flows table), per plan section 8.
//
// Scopes are least-privilege for publishing: upload, read-only channel
// identification, and the account email. Sheets/Drive scopes are deliberately
// NOT requested: a YouTube brand account cannot grant them, and Google then
// refuses the entire consent ("Service unavailable"), which would make
// brand-account channels unconnectable. That is the same trap the reference
// documents.

import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { SocialPlatform } from "@/lib/social-publish";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const YT_CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

export const YOUTUBE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload", // publish videos
  "https://www.googleapis.com/auth/youtube.readonly", // identify the channel (id + title)
  "https://www.googleapis.com/auth/userinfo.email", // show which account is connected
];

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export function getGoogleOAuthConfig(): GoogleOAuthConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  }
  return { clientId, clientSecret };
}

// Site origin used to build OAuth redirect URIs. This must match the
// "Authorized redirect URI" registered in the Google Cloud console exactly, so
// it comes from configuration, never from the incoming request URL (which can
// be a Vercel preview host).
export function getSiteOrigin(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_ORIGIN;
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

export function getOAuthRedirectUri(platform: SocialPlatform): string {
  return `${getSiteOrigin()}/api/social/oauth/${platform}/callback`;
}

// --- PKCE (RFC 7636) ---

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  // 32 random bytes encode to a 43-char base64url verifier, well within the
  // 43..128 spec range. The challenge is S256(verifier).
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildYoutubeAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: YOUTUBE_OAUTH_SCOPES.join(" "),
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force refresh-token issuance, including on reconnect
    include_granted_scopes: "true",
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

// --- state validation (pure) ---

export interface OAuthFlowRecord {
  state: string;
  platform: string;
  session_ref: string | null;
  expires_at: string; // ISO-8601
}

export type OAuthStateFailure =
  | "missing"
  | "state-mismatch"
  | "platform-mismatch"
  | "session-mismatch"
  | "expired";

// The CSRF check (plan section 8). Verifies the staged flow exists, targets the
// expected platform, was started by the same admin session, and has not
// expired. The route deletes the flow row before calling this so a state is
// single-use regardless of the verdict.
export function validateOAuthState(input: {
  flow: OAuthFlowRecord | null;
  expectedState: string;
  expectedPlatform: SocialPlatform;
  sessionRef: string;
  now?: number;
}): { ok: true } | { ok: false; reason: OAuthStateFailure } {
  const { flow, expectedState, expectedPlatform, sessionRef } = input;
  const now = input.now ?? Date.now();
  if (!flow) return { ok: false, reason: "missing" };
  if (flow.state !== expectedState) return { ok: false, reason: "state-mismatch" };
  if (flow.platform !== expectedPlatform) {
    return { ok: false, reason: "platform-mismatch" };
  }
  if (flow.session_ref !== sessionRef) {
    return { ok: false, reason: "session-mismatch" };
  }
  const exp = Date.parse(flow.expires_at);
  if (!Number.isFinite(exp) || exp <= now) return { ok: false, reason: "expired" };
  return { ok: true };
}

// --- token exchange, refresh, identity (network) ---

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export async function exchangeCodeForTokens(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret } = getGoogleOAuthConfig();
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
      code_verifier: input.codeVerifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${await safeText(res)}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}

export async function refreshAccessToken(input: {
  refreshToken: string;
}): Promise<{ access_token: string; expires_in: number }> {
  const { clientId, clientSecret } = getGoogleOAuthConfig();
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: input.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`token refresh failed: ${res.status} ${await safeText(res)}`);
  }
  return (await res.json()) as { access_token: string; expires_in: number };
}

export interface YoutubeChannelInfo {
  id: string;
  title: string;
}

export async function fetchYoutubeChannel(
  accessToken: string,
): Promise<YoutubeChannelInfo | null> {
  const res = await fetch(`${YT_CHANNELS_URL}?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    items?: Array<{ id: string; snippet?: { title?: string } }>;
  };
  const item = data.items?.[0];
  if (!item) return null;
  return { id: item.id, title: item.snippet?.title ?? "YouTube channel" };
}

export async function fetchGoogleEmail(
  accessToken: string,
): Promise<string | null> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { email?: string };
  return data.email ?? null;
}

export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // Best effort. The local row is marked revoked regardless.
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
