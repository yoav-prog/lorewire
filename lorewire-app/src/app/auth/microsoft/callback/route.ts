// GET /auth/microsoft/callback — handle Microsoft's redirect after sign-in.
// Parallel to /auth/google/callback; see that route's header for the
// full flow description. The provider_sub for Microsoft is the `oid`
// claim (per-user stable GUID), not `sub` (per-app stable).

import { NextResponse, type NextRequest } from "next/server";
import * as arctic from "arctic";

import { readAnonToken } from "@/lib/anon";
import { reconcileVotesForCookieToken } from "@/lib/poll-vote-reconciliation";
import {
  buildMicrosoftClient,
  verifyMicrosoftIdToken,
} from "@/lib/oauth-microsoft";
import {
  MICROSOFT_STATE_COOKIE,
  MICROSOFT_VERIFIER_COOKIE,
  NEXT_PATH_COOKIE,
  sanitizeNext,
} from "@/lib/oauth-cookies";
import { createUserSession } from "@/lib/user-session";
import { hashForLog, upsertUserOnSignIn } from "@/lib/users";

function clearOAuthCookies(res: NextResponse): void {
  res.cookies.delete(MICROSOFT_STATE_COOKIE);
  res.cookies.delete(MICROSOFT_VERIFIER_COOKIE);
  res.cookies.delete(NEXT_PATH_COOKIE);
}

function failRedirect(reason: string): NextResponse {
  console.warn("[auth microsoft callback] fail", { reason });
  const res = NextResponse.redirect(
    new URL(
      "/?auth_error=microsoft",
      process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "/",
    ),
  );
  clearOAuthCookies(res);
  return res;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const client = buildMicrosoftClient();
  if (!client) return failRedirect("not-configured");

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const storedState = req.cookies.get(MICROSOFT_STATE_COOKIE)?.value ?? null;
  const storedVerifier =
    req.cookies.get(MICROSOFT_VERIFIER_COOKIE)?.value ?? null;
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

  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim() ?? "";
  let claims;
  try {
    claims = await verifyMicrosoftIdToken(idToken, clientId);
  } catch (err) {
    return failRedirect(`id-token-${(err as Error).message.slice(0, 24)}`);
  }

  const anonymousId = await readAnonToken();

  let signed;
  try {
    signed = await upsertUserOnSignIn({
      provider: "microsoft",
      providerSub: claims.oid,
      email: claims.email,
      name: claims.name,
      pictureUrl: null,
      anonymousId,
    });
  } catch (err) {
    console.warn("[auth microsoft callback upsert-failed]", {
      err: (err as Error).message,
    });
    return failRedirect("upsert-failed");
  }

  if (signed.created || signed.linked) {
    try {
      await reconcileVotesForCookieToken(signed.user.id);
    } catch (err) {
      console.warn("[auth microsoft callback reconcile-failed]", {
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

  console.info("[auth microsoft callback ok]", {
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
