// GET /auth/microsoft/start — kick off the Microsoft Entra ID OAuth flow.
// Parallel to /auth/google/start; see that route's header for the full
// flow description.

import { NextResponse, type NextRequest } from "next/server";
import * as arctic from "arctic";

import { buildMicrosoftClient } from "@/lib/oauth-microsoft";
import {
  MICROSOFT_STATE_COOKIE,
  MICROSOFT_VERIFIER_COOKIE,
  NEXT_PATH_COOKIE,
  oauthCookieOpts,
  sanitizeNext,
} from "@/lib/oauth-cookies";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const client = buildMicrosoftClient();
  if (!client) {
    console.warn(
      "[auth microsoft start] MICROSOFT_CLIENT_ID/SECRET not configured",
    );
    return NextResponse.json(
      { error: "Microsoft sign-in is not configured" },
      { status: 503 },
    );
  }

  const state = arctic.generateState();
  const codeVerifier = arctic.generateCodeVerifier();
  const next = sanitizeNext(req.nextUrl.searchParams.get("next"));

  const scopes = ["openid", "email", "profile"];
  const url = client.createAuthorizationURL(state, codeVerifier, scopes);

  const res = NextResponse.redirect(url);
  res.cookies.set(MICROSOFT_STATE_COOKIE, state, oauthCookieOpts());
  res.cookies.set(MICROSOFT_VERIFIER_COOKIE, codeVerifier, oauthCookieOpts());
  if (next) res.cookies.set(NEXT_PATH_COOKIE, next, oauthCookieOpts());
  console.info("[auth microsoft start]", { has_next: next !== null });
  return res;
}
