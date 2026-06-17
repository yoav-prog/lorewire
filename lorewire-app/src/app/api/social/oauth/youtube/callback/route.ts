// GET /api/social/oauth/youtube/callback
//
// Google redirects here after consent. The flow:
//   1. require an admin session (the same one that started the flow);
//   2. consume the staged oauth_flows row so the `state` is single-use;
//   3. validate state (CSRF): platform + session-binding + TTL;
//   4. exchange the code for tokens with the stored PKCE verifier;
//   5. identify the channel, seal the tokens, store the connection.
// Every exit redirects back to the settings page with a status query param so
// the UI can render a clear banner. Plan section 8.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/dal";
import { tokenCipher } from "@/lib/token-cipher";
import {
  exchangeCodeForTokens,
  fetchGoogleEmail,
  fetchYoutubeChannel,
  getOAuthRedirectUri,
  validateOAuthState,
} from "@/lib/social-oauth";
import {
  deleteOAuthFlow,
  getOAuthFlow,
  upsertSocialAccount,
} from "@/lib/social-accounts";

const SETTINGS_PATH = "/admin/settings/social-accounts";

function settingsRedirect(
  req: Request,
  params: Record<string, string>,
): NextResponse {
  const url = new URL(SETTINGS_PATH, req.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(req: Request): Promise<NextResponse> {
  const session = await requireAdmin();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");

  if (providerError) {
    console.warn("[social oauth callback] provider error", {
      platform: "youtube",
      error: providerError,
    });
    return settingsRedirect(req, { error: "denied" });
  }
  if (!code || !state) {
    return settingsRedirect(req, { error: "bad-callback" });
  }

  // Consume the staged flow regardless of outcome so a state cannot be replayed.
  const flow = await getOAuthFlow(state);
  await deleteOAuthFlow(state);

  const verdict = validateOAuthState({
    flow,
    expectedState: state,
    expectedPlatform: "youtube",
    sessionRef: session.userId,
  });
  console.info("[social oauth callback]", {
    platform: "youtube",
    stateValid: verdict.ok,
    reason: verdict.ok ? undefined : verdict.reason,
  });
  if (!verdict.ok || !flow) {
    return settingsRedirect(req, { error: "state" });
  }

  try {
    const tokens = await exchangeCodeForTokens({
      code,
      codeVerifier: flow.code_verifier,
      redirectUri: getOAuthRedirectUri("youtube"),
    });

    const channel = await fetchYoutubeChannel(tokens.access_token);
    if (!channel) {
      console.error("[social oauth callback] no channel for granted token");
      return settingsRedirect(req, { error: "no-channel" });
    }
    const email = await fetchGoogleEmail(tokens.access_token);

    const cipher = tokenCipher();
    const expiresAt = new Date(
      Date.now() + tokens.expires_in * 1000,
    ).toISOString();
    await upsertSocialAccount({
      platform: "youtube",
      externalId: channel.id,
      displayName: email ? `${channel.title} (${email})` : channel.title,
      scopes: tokens.scope,
      accessTokenEnc: cipher.encrypt(tokens.access_token),
      refreshTokenEnc: tokens.refresh_token
        ? cipher.encrypt(tokens.refresh_token)
        : null,
      tokenExpiresAt: expiresAt,
    });

    console.info("[social oauth callback] connected", {
      platform: "youtube",
      externalId: channel.id,
      hasRefreshToken: Boolean(tokens.refresh_token),
    });
    return settingsRedirect(req, { connected: "youtube" });
  } catch (e) {
    console.error("[social oauth callback] exchange failed", {
      detail: e instanceof Error ? e.message : String(e),
    });
    return settingsRedirect(req, { error: "exchange" });
  }
}
