// POST /api/user/delete — self-serve "Delete my account".
//
// Same posture as the other public auth mutations: same-origin gate (CSRF
// defense, mirrors /api/auth/login + /auth/signout) plus the session cookie
// as the auth proof. Reuses the exact deleteUserCompletely the Meta callback
// uses, so the two deletion paths can never diverge. The session cookie is
// cleared AFTER the wipe commits — clearing it first would log the user out
// of an account that might still exist if the delete then failed.
//
// Plan: _plans/2026-06-22-facebook-login-and-data-deletion.md §C.

import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";

import {
  deleteUserCompletely,
  recordDeletionRequest,
} from "@/lib/account-deletion";
import { deleteUserSession, readUserSession } from "@/lib/user-session";
import { hashForLog } from "@/lib/users";

export const runtime = "nodejs";

let warnedAboutMissingSiteOriginInProd = false;

function isAllowedOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return process.env.NODE_ENV !== "production";
  const expected = process.env.NEXT_PUBLIC_SITE_ORIGIN?.trim() ?? "";
  if (expected) return origin === expected.replace(/\/$/, "");
  if (process.env.NODE_ENV !== "production") {
    return (
      /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)
    );
  }
  if (!warnedAboutMissingSiteOriginInProd) {
    warnedAboutMissingSiteOriginInProd = true;
    console.warn(
      "[user delete] NEXT_PUBLIC_SITE_ORIGIN unset in production — every delete will be rejected.",
    );
  }
  return false;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    console.warn("[user delete origin-rejected]", {
      received_origin: req.headers.get("origin"),
      expected_origin: process.env.NEXT_PUBLIC_SITE_ORIGIN ?? null,
    });
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  const session = await readUserSession();
  if (!session) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  try {
    await deleteUserCompletely(session.userId);
    await recordDeletionRequest({
      confirmationCode: randomUUID(),
      source: "self_serve",
      subject: session.userId,
      deleted: true,
    });
  } catch (err) {
    // Leave the session intact so the user can retry rather than being locked
    // out of an account that still partly exists.
    console.error("[user delete failed]", {
      user_id_hash: hashForLog(session.userId),
      err: (err as Error).message,
    });
    return NextResponse.json(
      { error: "Couldn't delete your account. Try again." },
      { status: 500 },
    );
  }

  await deleteUserSession();
  console.info("[user delete ok]", {
    user_id_hash: hashForLog(session.userId),
  });
  return NextResponse.json({ ok: true });
}
