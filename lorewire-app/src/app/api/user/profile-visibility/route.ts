// POST /api/user/profile-visibility — toggle the public contributor profile.
//
// Authenticated by the lw_user JWT cookie (readActiveUserSession, so a suspended
// account is treated as signed out). Body: { hidden: boolean }. Mirrors the
// origin + auth gates of /api/user/profile.
//
// Plan: _plans/2026-06-29-contributor-profiles-gamification.md.

import { NextResponse, type NextRequest } from "next/server";

import { readActiveUserSession } from "@/lib/member-session";
import { setProfileVisibility } from "@/lib/users";

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
      "[user profile-visibility] NEXT_PUBLIC_SITE_ORIGIN unset in production — every update will be rejected.",
    );
  }
  return false;
}

interface VisibilityBody {
  hidden?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    console.warn("[user profile-visibility origin-rejected]", {
      received_origin: req.headers.get("origin"),
      expected_origin: process.env.NEXT_PUBLIC_SITE_ORIGIN ?? null,
    });
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  const session = await readActiveUserSession();
  if (!session) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  let body: VisibilityBody;
  try {
    body = (await req.json()) as VisibilityBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (typeof body.hidden !== "boolean") {
    return NextResponse.json(
      { error: "hidden must be a boolean" },
      { status: 400 },
    );
  }

  try {
    await setProfileVisibility(session.userId, body.hidden);
    return NextResponse.json({ ok: true, hidden: body.hidden });
  } catch (err) {
    console.warn("[user profile-visibility update-failed]", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Couldn't update your profile visibility. Try again." },
      { status: 500 },
    );
  }
}
