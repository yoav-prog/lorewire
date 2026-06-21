// GET /auth/reddit/callback — handle Reddit's redirect after sign-in.
//
// Different shape from the Google + Microsoft callbacks:
//   - No PKCE verifier (Reddit doesn't support it; state alone defends
//     the round-trip).
//   - No id_token (Reddit isn't OIDC). We hit /api/v1/me with the
//     access token to read username + id.
//   - The user's email comes from a synthetic .invalid TLD (see
//     lib/oauth-reddit.ts header for the rationale).
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md.

import { NextResponse, type NextRequest } from "next/server";
import * as arctic from "arctic";

import { readAnonToken } from "@/lib/anon";
import {
  buildRedditClient,
  fetchRedditIdentity,
} from "@/lib/oauth-reddit";
import {
  NEXT_PATH_COOKIE,
  REDDIT_STATE_COOKIE,
  sanitizeNext,
} from "@/lib/oauth-cookies";
import { reconcileVotesForCookieToken } from "@/lib/poll-vote-reconciliation";
import { createUserSession } from "@/lib/user-session";
import { hashForLog, upsertUserOnSignIn } from "@/lib/users";

function clearOAuthCookies(res: NextResponse): void {
  res.cookies.delete(REDDIT_STATE_COOKIE);
  res.cookies.delete(NEXT_PATH_COOKIE);
}

function failRedirect(reason: string): NextResponse {
  console.warn("[auth reddit callback] fail", { reason });
  const res = NextResponse.redirect(
    new URL(
      "/?auth_error=reddit",
      process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "/",
    ),
  );
  clearOAuthCookies(res);
  return res;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const client = buildRedditClient();
  if (!client) return failRedirect("not-configured");

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const storedState = req.cookies.get(REDDIT_STATE_COOKIE)?.value ?? null;
  const next =
    sanitizeNext(req.cookies.get(NEXT_PATH_COOKIE)?.value ?? null) ?? "/";

  if (!code || !state || !storedState) {
    return failRedirect("missing-params");
  }
  if (state !== storedState) {
    return failRedirect("state-mismatch");
  }

  let accessToken: string;
  try {
    const tokens = await client.validateAuthorizationCode(code);
    accessToken = tokens.accessToken();
  } catch (err) {
    if (err instanceof arctic.OAuth2RequestError) {
      return failRedirect(`oauth2-${err.code}`);
    }
    return failRedirect("token-exchange-failed");
  }

  let identity;
  try {
    identity = await fetchRedditIdentity(accessToken);
  } catch (err) {
    return failRedirect(`me-${(err as Error).message.slice(0, 24)}`);
  }

  const anonymousId = await readAnonToken();

  let signed;
  try {
    signed = await upsertUserOnSignIn({
      provider: "reddit",
      providerSub: identity.redditId,
      email: identity.syntheticEmail,
      name: identity.username,
      pictureUrl: identity.iconUrl,
      anonymousId,
    });
  } catch (err) {
    console.warn("[auth reddit callback upsert-failed]", {
      err: (err as Error).message,
    });
    return failRedirect("upsert-failed");
  }

  if (signed.created || signed.linked) {
    try {
      await reconcileVotesForCookieToken(signed.user.id);
    } catch (err) {
      console.warn("[auth reddit callback reconcile-failed]", {
        user_id_hash: hashForLog(signed.user.id),
        err: (err as Error).message,
      });
    }
  }

  await createUserSession({
    userId: signed.user.id,
    email: signed.user.email,
    role: "user",
  });

  console.info("[auth reddit callback ok]", {
    user_id_hash: hashForLog(signed.user.id),
    created: signed.created,
    linked: signed.linked,
  });

  const res = NextResponse.redirect(
    new URL(next, process.env.NEXT_PUBLIC_SITE_ORIGIN ?? req.nextUrl.origin),
  );
  clearOAuthCookies(res);
  return res;
}
