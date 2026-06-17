// GET /api/social/oauth/youtube/start
//
// Begins the YouTube connect flow: mints a single-use, session-bound `state`
// and a PKCE verifier, stages them in oauth_flows, and redirects the admin to
// Google's consent screen. The redirect_uri sent to Google comes from the
// configured site origin (it must match the Google Cloud console exactly), not
// from the incoming request URL. Plan section 8.

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { requireAdmin } from "@/lib/dal";
import {
  buildYoutubeAuthUrl,
  generatePkce,
  getGoogleOAuthConfig,
  getOAuthRedirectUri,
} from "@/lib/social-oauth";
import { createOAuthFlow } from "@/lib/social-accounts";

const SETTINGS_PATH = "/admin/settings/social-accounts";

export async function GET(req: Request): Promise<NextResponse> {
  const session = await requireAdmin();

  let clientId: string;
  try {
    ({ clientId } = getGoogleOAuthConfig());
  } catch {
    console.error("[social oauth start] missing Google OAuth config");
    const url = new URL(SETTINGS_PATH, req.url);
    url.searchParams.set("error", "config");
    return NextResponse.redirect(url);
  }

  // 256-bit single-use state, plus a PKCE verifier kept server-side.
  const state = randomBytes(32).toString("base64url");
  const { verifier, challenge } = generatePkce();

  await createOAuthFlow({
    state,
    platform: "youtube",
    codeVerifier: verifier,
    sessionRef: session.userId,
  });

  const authUrl = buildYoutubeAuthUrl({
    clientId,
    redirectUri: getOAuthRedirectUri("youtube"),
    state,
    codeChallenge: challenge,
  });

  console.info("[social oauth start]", {
    platform: "youtube",
    sessionRef: session.userId,
  });
  return NextResponse.redirect(authUrl);
}
