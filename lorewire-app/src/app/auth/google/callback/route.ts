// GET /auth/google/callback — handle Google's redirect after sign-in.
//
// The flow:
//   1. Read code + state from the URL.
//   2. Read state + verifier from cookies (set by /auth/google/start).
//   3. Verify state matches (CSRF guard).
//   4. Exchange code for tokens via arctic.
//   5. Verify the id_token (signature + iss + aud + exp + email_verified).
//   6. Upsert the users row through the identity-resolution helper.
//   7. On first sign-in for this anon browser, reconcile prior poll votes.
//   8. Issue lw_user session cookie.
//   9. Clear all OAuth bookkeeping cookies.
//  10. Redirect to the `next` cookie path or `/`.
//
// Errors NEVER expose the cause to the response body (rule 13). A bad
// id_token signature looks identical to a bad nonce — the user just sees
// "Sign-in failed."
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §Sign-in flow + §Security.

import { NextResponse, type NextRequest } from "next/server";
import * as arctic from "arctic";

import { readAnonToken } from "@/lib/anon";
import { reconcileVotesForCookieToken } from "@/lib/poll-vote-reconciliation";
import { buildGoogleClient, verifyGoogleIdToken } from "@/lib/oauth-google";
import {
  GOOGLE_STATE_COOKIE,
  GOOGLE_VERIFIER_COOKIE,
  NEXT_PATH_COOKIE,
  sanitizeNext,
} from "@/lib/oauth-cookies";
import { createUserSession } from "@/lib/user-session";
import { hashForLog, upsertUserOnSignIn } from "@/lib/users";

function clearOAuthCookies(res: NextResponse): void {
  res.cookies.delete(GOOGLE_STATE_COOKIE);
  res.cookies.delete(GOOGLE_VERIFIER_COOKIE);
  res.cookies.delete(NEXT_PATH_COOKIE);
}

function failRedirect(reason: string): NextResponse {
  console.warn("[auth google callback] fail", { reason });
  const res = NextResponse.redirect(
    new URL("/?auth_error=google", process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "/"),
  );
  clearOAuthCookies(res);
  return res;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const client = buildGoogleClient();
  if (!client) return failRedirect("not-configured");

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const storedState = req.cookies.get(GOOGLE_STATE_COOKIE)?.value ?? null;
  const storedVerifier =
    req.cookies.get(GOOGLE_VERIFIER_COOKIE)?.value ?? null;
  const next =
    sanitizeNext(req.cookies.get(NEXT_PATH_COOKIE)?.value ?? null) ?? "/";

  if (!code || !state || !storedState || !storedVerifier) {
    return failRedirect("missing-params");
  }
  if (state !== storedState) {
    return failRedirect("state-mismatch");
  }

  let idToken: string;
  try {
    const tokens = await client.validateAuthorizationCode(code, storedVerifier);
    idToken = tokens.idToken();
  } catch (err) {
    if (err instanceof arctic.OAuth2RequestError) {
      return failRedirect(`oauth2-${err.code}`);
    }
    return failRedirect("token-exchange-failed");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  let claims;
  try {
    claims = await verifyGoogleIdToken(idToken, clientId);
  } catch (err) {
    return failRedirect(`id-token-${(err as Error).message.slice(0, 24)}`);
  }

  const anonymousId = await readAnonToken();

  let signed;
  try {
    signed = await upsertUserOnSignIn({
      provider: "google",
      providerSub: claims.sub,
      email: claims.email,
      name: claims.name,
      pictureUrl: claims.picture,
      anonymousId,
    });
  } catch (err) {
    console.warn("[auth google callback upsert-failed]", {
      err: (err as Error).message,
    });
    return failRedirect("upsert-failed");
  }

  // Poll-vote reconciliation: only worth running on FIRST sign-in for
  // this browser. After that, repeated sign-ins from the same browser
  // are no-ops (the cookie_token's votes are already tagged with user_id).
  if (signed.created || signed.linked) {
    try {
      await reconcileVotesForCookieToken(signed.user.id);
    } catch (err) {
      // Reconciliation is best-effort — a failure here shouldn't block
      // sign-in. Log loud so we can spot a systematic break.
      console.warn("[auth google callback reconcile-failed]", {
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

  console.info("[auth google callback ok]", {
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
