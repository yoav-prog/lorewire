// GET /auth/facebook/start — kick off the Facebook OAuth flow.
//
// Like Reddit, arctic's Facebook createAuthorizationURL takes (state, scopes)
// only — no PKCE verifier. We set the state cookie + the optional next-path
// cookie; the verifier cookies the Google/Microsoft starts use don't apply.
// Plan: _plans/2026-06-22-facebook-login-and-data-deletion.md.

import { NextResponse, type NextRequest } from "next/server";
import * as arctic from "arctic";

import { buildFacebookClient } from "@/lib/oauth-facebook";
import {
  FACEBOOK_STATE_COOKIE,
  NEXT_PATH_COOKIE,
  oauthCookieOpts,
  sanitizeNext,
} from "@/lib/oauth-cookies";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const client = buildFacebookClient();
  if (!client) {
    console.warn(
      "[auth facebook start] FACEBOOK_CLIENT_ID/META_APP_SECRET not configured",
    );
    return NextResponse.json(
      { error: "Facebook sign-in is not configured" },
      { status: 503 },
    );
  }

  const state = arctic.generateState();
  const next = sanitizeNext(req.nextUrl.searchParams.get("next"));

  // `public_profile` covers name + picture; `email` is the address we anchor
  // the account on when the user grants it. Both are pre-approved default
  // permissions, so no App Review is needed and the consent screen stays
  // light. Nothing broader is requested — login needs no more.
  const scopes = ["email", "public_profile"];
  const url = client.createAuthorizationURL(state, scopes);

  const res = NextResponse.redirect(url);
  res.cookies.set(FACEBOOK_STATE_COOKIE, state, oauthCookieOpts());
  if (next) res.cookies.set(NEXT_PATH_COOKIE, next, oauthCookieOpts());
  console.info("[auth facebook start]", { has_next: next !== null });
  return res;
}
