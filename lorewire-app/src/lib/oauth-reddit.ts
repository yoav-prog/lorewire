// Reddit OAuth 2.0. Three things this provider needs that Google and
// Microsoft don't:
//
//   1. NO PKCE. arctic's Reddit client doesn't take a codeVerifier in
//      createAuthorizationURL or validateAuthorizationCode — Reddit's
//      OAuth flow predates PKCE. State alone defends the round-trip.
//
//   2. NO id_token. Reddit isn't an OIDC provider — the token-exchange
//      response is just access_token. Identity comes from a separate
//      GET to oauth.reddit.com/api/v1/me with the bearer token.
//
//   3. NO reliable email. Reddit returns `has_verified_email` (boolean)
//      but the email address itself is rarely populated and never
//      guaranteed. Our users.ts model anchors on email, so we synthesize
//      one in the RFC-6761 reserved `.invalid` TLD:
//          <reddit_id>@reddit.user.lorewire.invalid
//      That value can never collide with a real email and stays unique
//      per Reddit account. Cross-provider linking by email (the Google
//      → existing-row path in upsertUserOnSignIn) doesn't fire for
//      Reddit users — which is the right outcome: a Reddit identity
//      is its own anchor.
//
// Reddit also requires a descriptive User-Agent header on API calls or
// the request gets soft-rate-limited. Format follows their guidance:
// `<platform>:<app>:<version> (by /u/<owner>)`.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §UI surfaces.

import "server-only";
import * as arctic from "arctic";

const REDDIT_ME_URL = "https://oauth.reddit.com/api/v1/me";
const REDDIT_UA = "web:com.lorewire.app:v1 (by /u/lorewire)";

export interface RedditConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function readRedditConfig(): RedditConfig | null {
  const clientId = process.env.REDDIT_CLIENT_ID?.trim();
  const clientSecret = process.env.REDDIT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const origin = process.env.NEXT_PUBLIC_SITE_ORIGIN?.trim();
  if (!origin) {
    throw new Error(
      "NEXT_PUBLIC_SITE_ORIGIN must be set to construct the Reddit redirect URI",
    );
  }
  const redirectUri = `${origin.replace(/\/$/, "")}/auth/reddit/callback`;
  return { clientId, clientSecret, redirectUri };
}

export function buildRedditClient(): arctic.Reddit | null {
  const cfg = readRedditConfig();
  if (!cfg) return null;
  return new arctic.Reddit(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
}

/** Reddit's /api/v1/me payload, narrowed to fields we use. The full
 *  payload is large; we don't validate the rest. */
interface RedditMeResponse {
  id?: unknown;
  name?: unknown;
  icon_img?: unknown;
}

export interface RedditIdentity {
  /** Reddit's stable `id` field (e.g. "t2_abc123" minus the t2_ prefix
   *  on some endpoints). We pass it through verbatim. */
  redditId: string;
  username: string;
  /** Synthetic anchor in the RFC-6761 reserved `.invalid` TLD. Never
   *  collides with a real email. */
  syntheticEmail: string;
  /** Reddit profile picture URL, if the user has one set. May be null
   *  for default-avatar accounts. */
  iconUrl: string | null;
}

/** Fetch the signed-in Reddit user's identity. Throws on transport
 *  failure, non-OK status, or missing required fields. The route handler
 *  catches and maps to a generic failure response — never expose the
 *  raw cause to the user. */
export async function fetchRedditIdentity(
  accessToken: string,
): Promise<RedditIdentity> {
  const res = await fetch(REDDIT_ME_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": REDDIT_UA,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Reddit /me returned ${res.status}`);
  }
  const payload = (await res.json()) as RedditMeResponse;
  const redditId = typeof payload.id === "string" ? payload.id : "";
  if (!redditId) throw new Error("Reddit /me missing id");
  const username = typeof payload.name === "string" ? payload.name : "";
  if (!username) throw new Error("Reddit /me missing name");
  const iconRaw = typeof payload.icon_img === "string" ? payload.icon_img : "";
  // Reddit appends an ?<cachebuster> query string we can keep — it's a
  // valid URL. We just trim whitespace and strip if empty.
  const iconUrl = iconRaw.trim() || null;
  return {
    redditId,
    username,
    syntheticEmail: `${redditId}@reddit.user.lorewire.invalid`,
    iconUrl,
  };
}
