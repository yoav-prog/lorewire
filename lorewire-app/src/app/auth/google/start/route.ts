// GET /auth/google/start — kick off the Google OAuth flow.
//
// Stores PKCE verifier + state + nonce + the post-sign-in `next` URL
// in short-lived HttpOnly cookies (10 min), then redirects to Google's
// authorization endpoint.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §Sign-in flow.

import { NextResponse, type NextRequest } from "next/server";
import * as arctic from "arctic";

import { buildGoogleClient } from "@/lib/oauth-google";
import {
  GOOGLE_STATE_COOKIE,
  GOOGLE_VERIFIER_COOKIE,
  NEXT_PATH_COOKIE,
  oauthCookieOpts,
  sanitizeNext,
} from "@/lib/oauth-cookies";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const client = buildGoogleClient();
  if (!client) {
    console.warn("[auth google start] GOOGLE_CLIENT_ID/SECRET not configured");
    return NextResponse.json(
      { error: "Google sign-in is not configured" },
      { status: 503 },
    );
  }

  const state = arctic.generateState();
  const codeVerifier = arctic.generateCodeVerifier();
  const next = sanitizeNext(req.nextUrl.searchParams.get("next"));

  const scopes = ["openid", "email", "profile"];
  const url = client.createAuthorizationURL(state, codeVerifier, scopes);

  const res = NextResponse.redirect(url);
  res.cookies.set(GOOGLE_STATE_COOKIE, state, oauthCookieOpts());
  res.cookies.set(GOOGLE_VERIFIER_COOKIE, codeVerifier, oauthCookieOpts());
  if (next) res.cookies.set(NEXT_PATH_COOKIE, next, oauthCookieOpts());
  console.info("[auth google start]", { has_next: next !== null });
  return res;
}
