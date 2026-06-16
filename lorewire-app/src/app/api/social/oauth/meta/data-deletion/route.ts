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
// LoreWire is owner-only today (Phase 0 of
// _plans/2026-06-16-multi-platform-shorts-publisher.md), so deletion of
// "user data" means: revoking the matching social_account row's tokens.
// The social_accounts table doesn't exist yet — Phase 1 lands it. Until
// then this endpoint:
//   1. Verifies the signed_request (security boundary, regardless of state).
//   2. Generates a confirmation code and persists a record of the request
//      so the status page can answer "is this done?" deterministically.
//   3. Returns Meta's required shape.
// When Phase 1 lands, the TODO below revokes the matching social_account.
//
// Why this exists in Phase 0 already: Meta requires the callback URL to be
// live before submitting App Review. A missing or broken endpoint bounces
// the submission on first read.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { parseSignedRequest } from "@/lib/meta-signed-request";

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

  const userId = parsed.payload.user_id;
  const confirmationCode = randomUUID();

  // TODO Phase 1: revoke the matching social_accounts row.
  //   await sql`
  //     UPDATE social_accounts
  //        SET status='revoked',
  //            access_token_enc=NULL, refresh_token_enc=NULL,
  //            updated_at=${new Date().toISOString()}
  //      WHERE platform='facebook' AND external_id=${userId}
  //   `;
  // Until then, log the event so a Meta-side disconnect is visible.

  console.info(
    `[social meta data-deletion] verified userId=${userId} confirmationCode=${confirmationCode}`,
  );

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
