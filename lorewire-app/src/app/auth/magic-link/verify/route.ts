// GET /auth/magic-link/verify?token=...&next=... — the magic-link click.
//
// Consume the token (single-use, expiry-checked), upsert the users row
// (same code path the OAuth callbacks use), reconcile prior poll votes
// when this is a first sign-in for the browser, issue lw_user session,
// redirect to `next` or `/`.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md.

import { NextResponse, type NextRequest } from "next/server";

import { readAnonToken } from "@/lib/anon";
import { consumeMagicLink } from "@/lib/magic-link";
import { sanitizeNext } from "@/lib/oauth-cookies";
import { reconcileVotesForCookieToken } from "@/lib/poll-vote-reconciliation";
import { createUserSession } from "@/lib/user-session";
import { hashForLog, upsertUserOnSignIn } from "@/lib/users";

function failRedirect(reason: string): NextResponse {
  console.warn("[auth magic-link verify] fail", { reason });
  return NextResponse.redirect(
    new URL(
      "/?auth_error=magic_link",
      process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "/",
    ),
  );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.nextUrl.searchParams.get("token");
  const next = sanitizeNext(req.nextUrl.searchParams.get("next")) ?? "/";

  if (!token) return failRedirect("missing-token");

  const claim = await consumeMagicLink(token);
  if (!claim) return failRedirect("invalid-or-used");

  // Magic-link `provider_sub` is the email itself. Justification: there's
  // no provider-issued stable identifier for a magic-link sign-in — the
  // email IS the identity. This means a second magic-link sign-in for
  // the same email hits the (provider='magic_link', provider_sub=email)
  // index and reuses the existing row. If the user later signs in with
  // Google on the same email, the cross-provider link step in
  // upsertUserOnSignIn promotes the row to provider='google' without
  // creating a duplicate.
  const anonymousId = await readAnonToken();
  let signed;
  try {
    signed = await upsertUserOnSignIn({
      provider: "magic_link",
      providerSub: claim.email,
      email: claim.email,
      anonymousId,
    });
  } catch (err) {
    console.warn("[auth magic-link verify upsert-failed]", {
      err: (err as Error).message,
    });
    return failRedirect("upsert-failed");
  }

  if (signed.created || signed.linked) {
    try {
      await reconcileVotesForCookieToken(signed.user.id);
    } catch (err) {
      console.warn("[auth magic-link verify reconcile-failed]", {
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

  console.info("[auth magic-link verify ok]", {
    user_id_hash: hashForLog(signed.user.id),
    created: signed.created,
    linked: signed.linked,
  });

  return NextResponse.redirect(
    new URL(next, process.env.NEXT_PUBLIC_SITE_ORIGIN ?? req.nextUrl.origin),
  );
}
