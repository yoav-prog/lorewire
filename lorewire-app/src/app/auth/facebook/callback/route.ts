// GET /auth/facebook/callback — handle Facebook's redirect after sign-in.
//
// Same shape as the Reddit callback (no PKCE verifier, identity via a /me
// fetch) with one Facebook-specific difference: arctic's Facebook
// validateAuthorizationCode does NOT throw arctic.OAuth2RequestError
// (Facebook's error responses are non-RFC), so there's no `instanceof`
// branch — any rejection maps to the same generic failure.
//
// Email handling lives in lib/oauth-facebook.ts: a real confirmed email when
// Facebook returns one (merge-eligible, squatter guard still applies), else a
// synthetic .invalid anchor.
//
// Plan: _plans/2026-06-22-facebook-login-and-data-deletion.md §A.

import { NextResponse, type NextRequest } from "next/server";

import { readAnonToken } from "@/lib/anon";
import {
  buildFacebookClient,
  fetchFacebookIdentity,
} from "@/lib/oauth-facebook";
import {
  FACEBOOK_STATE_COOKIE,
  NEXT_PATH_COOKIE,
  sanitizeNext,
} from "@/lib/oauth-cookies";
import { reconcileVotesForCookieToken } from "@/lib/poll-vote-reconciliation";
import { createUserSession } from "@/lib/user-session";
import { hashForLog, upsertUserOnSignIn } from "@/lib/users";

function clearOAuthCookies(res: NextResponse): void {
  res.cookies.delete(FACEBOOK_STATE_COOKIE);
  res.cookies.delete(NEXT_PATH_COOKIE);
}

function failRedirect(reason: string): NextResponse {
  console.warn("[auth facebook callback] fail", { reason });
  const res = NextResponse.redirect(
    new URL("/?auth_error=facebook", process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "/"),
  );
  clearOAuthCookies(res);
  return res;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const client = buildFacebookClient();
  if (!client) return failRedirect("not-configured");

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const storedState = req.cookies.get(FACEBOOK_STATE_COOKIE)?.value ?? null;
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
    // arctic's Facebook client doesn't throw OAuth2RequestError — a non-RFC
    // error response surfaces as a plain rejected promise, caught here.
    const tokens = await client.validateAuthorizationCode(code);
    accessToken = tokens.accessToken();
  } catch {
    return failRedirect("token-exchange-failed");
  }

  let identity;
  try {
    identity = await fetchFacebookIdentity(accessToken);
  } catch (err) {
    return failRedirect(`me-${(err as Error).message.slice(0, 24)}`);
  }

  const anonymousId = await readAnonToken();

  let signed;
  try {
    signed = await upsertUserOnSignIn({
      provider: "facebook",
      providerSub: identity.facebookId,
      email: identity.email,
      name: identity.name,
      pictureUrl: identity.pictureUrl,
      anonymousId,
    });
  } catch (err) {
    console.warn("[auth facebook callback upsert-failed]", {
      err: (err as Error).message,
    });
    return failRedirect("upsert-failed");
  }

  if (signed.created || signed.linked) {
    try {
      await reconcileVotesForCookieToken(signed.user.id);
    } catch (err) {
      console.warn("[auth facebook callback reconcile-failed]", {
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

  console.info("[auth facebook callback ok]", {
    user_id_hash: hashForLog(signed.user.id),
    created: signed.created,
    linked: signed.linked,
    real_email: identity.hasRealEmail,
  });

  const res = NextResponse.redirect(
    new URL(next, process.env.NEXT_PUBLIC_SITE_ORIGIN ?? req.nextUrl.origin),
  );
  clearOAuthCookies(res);
  return res;
}
