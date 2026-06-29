// POST /api/social/oauth/meta/data-deletion
//
// Meta's required callback for the "Data Deletion" obligation in App
// Review. Fires when a user removes the Lorewire app from their Meta
// account. The request body is form-encoded with a single field
// `signed_request` that we verify against META_APP_SECRET.
//
// Response shape Meta requires:
//   { url: "<public status URL>", confirmation_code: "<our internal id>" }
//
// What "delete user data" means here:
//   - Facebook LOGIN users (2026-06-22): the signed_request `user_id` is the
//     Facebook app-scoped id, which is exactly the `provider_sub` we store at
//     login. So we find that user and run deleteUserCompletely — the same
//     wipe the self-serve "Delete my account" button uses. This is the live,
//     load-bearing path now that people can sign in with Facebook.
//   - PUBLISHER accounts: when the shorts publisher lands a social_accounts
//     table, the TODO below also revokes the matching row's tokens. Not built
//     yet (Phase 1 of _plans/2026-06-16-multi-platform-shorts-publisher.md).
//
// This endpoint always:
//   1. Verifies the signed_request HMAC (security boundary, regardless of state).
//   2. Deletes any matching account data.
//   3. Records the request keyed by confirmation_code so the status page can
//      answer "is this done?" deterministically.
//   4. Returns Meta's required { url, confirmation_code } shape.
//
// A verified signature that matches NO account is logged as a warning, not a
// silent success — that asymmetry is how a broken id-join (the one assumption
// this whole path rests on) becomes visible instead of no-op'ing forever.
//
// Plan: _plans/2026-06-22-facebook-login-and-data-deletion.md §B.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  deleteUserCompletely,
  recordDeletionRequest,
} from "@/lib/account-deletion";
import { parseSignedRequest } from "@/lib/meta-signed-request";
import { getUserByProvider, hashForLog } from "@/lib/users";

export const runtime = "nodejs";

function siteOrigin(): string {
  // Reviewers visit the status URL. It must be the real public origin,
  // never localhost.
  return (
    process.env.NEXT_PUBLIC_SITE_ORIGIN?.replace(/\/$/, "") ??
    "https://lorewire.com"
  );
}

export async function POST(req: Request): Promise<NextResponse> {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    // Misconfiguration on our side. Return 500 so Meta retries; do NOT
    // accept the request silently (that would be a security failure).
    console.error(
      "[social meta data-deletion] META_APP_SECRET not configured",
    );
    return NextResponse.json({ error: "not-configured" }, { status: 500 });
  }

  let signedRequest: string | null = null;
  try {
    const form = await req.formData();
    const v = form.get("signed_request");
    signedRequest = typeof v === "string" ? v : null;
  } catch {
    // Meta posts form-encoded. A non-form body is malformed.
    console.warn(
      "[social meta data-deletion] body not form-encoded, rejecting",
    );
    return NextResponse.json({ error: "bad-body" }, { status: 400 });
  }

  const parsed = parseSignedRequest(signedRequest, appSecret);
  if (!parsed.ok) {
    console.warn(
      `[social meta data-deletion] verification failed reason=${parsed.reason}`,
    );
    return NextResponse.json({ error: parsed.reason }, { status: 400 });
  }

  // `user_id` is the Facebook app-scoped id. NEVER log it raw (rule 13) — the
  // hashForLog digest is enough to correlate support requests.
  const facebookUserId = parsed.payload.user_id;
  const confirmationCode = randomUUID();

  // Login path: find the Facebook user this id belongs to and wipe them.
  let deletedUser = false;
  try {
    const user = await getUserByProvider("facebook", facebookUserId);
    if (user) {
      await deleteUserCompletely(user.id);
      deletedUser = true;
    }
  } catch (err) {
    // A genuine deletion failure must NOT report success. Return 500 so Meta
    // retries; deleteUserCompletely is idempotent so the retry is safe.
    console.error("[social meta data-deletion] deletion failed", {
      subject_hash: hashForLog(facebookUserId),
      err: (err as Error).message,
    });
    return NextResponse.json({ error: "deletion-failed" }, { status: 500 });
  }

  // TODO publisher phase: also revoke the matching social_accounts row's
  // tokens once that table exists (Phase 1 of
  // _plans/2026-06-16-multi-platform-shorts-publisher.md).

  await recordDeletionRequest({
    confirmationCode,
    source: "facebook",
    subject: facebookUserId,
    deleted: deletedUser,
  });

  if (deletedUser) {
    console.info("[social meta data-deletion] account deleted", {
      subject_hash: hashForLog(facebookUserId),
      confirmation_code: confirmationCode,
    });
  } else {
    // Verified signature, no matching account. Could be legitimate (the user
    // never signed in with Facebook, or was already deleted), but if it fires
    // for real Facebook-login users it means the id-join is broken — surface
    // it loudly rather than letting deletions silently no-op.
    console.warn("[social meta data-deletion] verified but no matching user", {
      subject_hash: hashForLog(facebookUserId),
      confirmation_code: confirmationCode,
    });
  }

  return NextResponse.json({
    url: `${siteOrigin()}/data-deletion/${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
}

// Reviewers sometimes hit the URL with GET to confirm it exists. Return a
// helpful 200 so the dashboard doesn't flag the endpoint as unreachable.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    endpoint: "meta-data-deletion-callback",
    method: "POST",
    docs: "https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback",
  });
}
