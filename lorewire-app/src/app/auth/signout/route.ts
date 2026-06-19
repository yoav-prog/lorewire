// POST /auth/signout — clear the `lw_user` session cookie. Anonymous
// state (lw_anon, lw.saved.v1, lw.liked.v1, etc.) stays on the device —
// the user is just no longer authenticated. Sign-in flips them back to
// the same identity.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §Sign-out.

import { NextResponse, type NextRequest } from "next/server";

import { deleteUserSession, readUserSession } from "@/lib/user-session";
import { hashForLog } from "@/lib/users";

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
      "[auth signout] NEXT_PUBLIC_SITE_ORIGIN unset in production — every signout will be rejected.",
    );
  }
  return false;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }
  const existing = await readUserSession();
  await deleteUserSession();
  console.info("[auth signout]", {
    user_id_hash: existing ? hashForLog(existing.userId) : null,
  });
  return NextResponse.json({ ok: true });
}
