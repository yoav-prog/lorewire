// GET /auth/reddit/start — kick off the Reddit OAuth flow.
//
// Reddit's createAuthorizationURL takes (state, scopes) only — no
// PKCE verifier. We only set the state cookie + the optional next-path
// cookie; the verifier cookies the Google/Microsoft starts use don't
// apply here. Plan: _plans/2026-06-19-anonymous-first-auth.md.

import { NextResponse, type NextRequest } from "next/server";
import * as arctic from "arctic";

import { buildRedditClient } from "@/lib/oauth-reddit";
import {
  REDDIT_STATE_COOKIE,
  NEXT_PATH_COOKIE,
  oauthCookieOpts,
  sanitizeNext,
} from "@/lib/oauth-cookies";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const client = buildRedditClient();
  if (!client) {
    console.warn("[auth reddit start] REDDIT_CLIENT_ID/SECRET not configured");
    return NextResponse.json(
      { error: "Reddit sign-in is not configured" },
      { status: 503 },
    );
  }

  const state = arctic.generateState();
  const next = sanitizeNext(req.nextUrl.searchParams.get("next"));

  // `identity` is the smallest scope that lets us call /api/v1/me to
  // read username + id. Anything broader would request capabilities we
  // don't use and would scare off users on the consent screen.
  const scopes = ["identity"];
  const url = client.createAuthorizationURL(state, scopes);

  const res = NextResponse.redirect(url);
  res.cookies.set(REDDIT_STATE_COOKIE, state, oauthCookieOpts());
  if (next) res.cookies.set(NEXT_PATH_COOKIE, next, oauthCookieOpts());
  console.info("[auth reddit start]", { has_next: next !== null });
  return res;
}
