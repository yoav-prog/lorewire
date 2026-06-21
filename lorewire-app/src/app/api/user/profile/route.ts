// POST /api/user/profile — public-user profile update.
//
// Authenticated by the lw_user JWT cookie. Updatable fields: name,
// picture_url. Email is read-only here — see lib/users.ts:updateUserProfile
// for the rationale.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §UI surfaces.

import { NextResponse, type NextRequest } from "next/server";

import { readUserSession } from "@/lib/user-session";
import { updateUserProfile } from "@/lib/users";

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
      "[user profile] NEXT_PUBLIC_SITE_ORIGIN unset in production — every update will be rejected.",
    );
  }
  return false;
}

interface ProfileBody {
  name?: unknown;
  pictureUrl?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    console.warn("[user profile origin-rejected]", {
      received_origin: req.headers.get("origin"),
      expected_origin: process.env.NEXT_PUBLIC_SITE_ORIGIN ?? null,
    });
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  const session = await readUserSession();
  if (!session) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  let body: ProfileBody;
  try {
    body = (await req.json()) as ProfileBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Only forward keys the client actually sent — `updateUserProfile`
  // uses hasOwnProperty to distinguish "leave alone" from "set to null",
  // and we need to preserve that semantic across the JSON wire.
  const patch: { name?: string | null; pictureUrl?: string | null } = {};
  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    if (typeof body.name === "string" || body.name === null) {
      patch.name = body.name;
    } else if (body.name !== undefined) {
      return NextResponse.json({ error: "name must be a string" }, { status: 400 });
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "pictureUrl")) {
    if (typeof body.pictureUrl === "string" || body.pictureUrl === null) {
      patch.pictureUrl = body.pictureUrl;
    } else if (body.pictureUrl !== undefined) {
      return NextResponse.json(
        { error: "pictureUrl must be a string" },
        { status: 400 },
      );
    }
  }

  try {
    const updated = await updateUserProfile(session.userId, patch);
    return NextResponse.json({
      ok: true,
      profile: {
        name: updated.name,
        pictureUrl: updated.picture_url,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "update failed";
    // Validation errors are user-facing — surface the message directly
    // (it's short and intentionally written for that). Unknown errors
    // get a generic 500 line so we don't leak internals.
    if (
      msg.includes("too long") ||
      msg.includes("not allowed") ||
      msg.includes("must start with")
    ) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.warn("[user profile update-failed]", { err: msg });
    return NextResponse.json(
      { error: "Couldn't update your profile. Try again." },
      { status: 500 },
    );
  }
}
