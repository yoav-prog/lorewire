// POST /api/auth/signup — email + password account creation.
//
// Same-origin gated like every other write route. On success: poll-vote
// reconciliation, lw_user session issued, returns ok + the redirect
// target. We don't return the user object — the client just navigates
// to next/home and the server re-renders with the cookie.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §UI surfaces.

import { NextResponse, type NextRequest } from "next/server";

import { readAnonToken } from "@/lib/anon";
import { sanitizeNext } from "@/lib/oauth-cookies";
import { reconcileVotesForCookieToken } from "@/lib/poll-vote-reconciliation";
import { createUserSession } from "@/lib/user-session";
import {
  createPasswordUser,
  hashForLog,
  PublicAuthError,
} from "@/lib/users";

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
      "[auth signup] NEXT_PUBLIC_SITE_ORIGIN unset in production — every signup will be rejected.",
    );
  }
  return false;
}

interface SignupBody {
  email?: unknown;
  password?: unknown;
  next?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    console.warn("[auth signup origin-rejected]", {
      received_origin: req.headers.get("origin"),
      expected_origin: process.env.NEXT_PUBLIC_SITE_ORIGIN ?? null,
    });
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  let body: SignupBody;
  try {
    body = (await req.json()) as SignupBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  const next = sanitizeNext(typeof body.next === "string" ? body.next : null);

  const anonymousId = await readAnonToken();

  let user;
  try {
    user = await createPasswordUser({ email, password, anonymousId });
  } catch (err) {
    if (err instanceof PublicAuthError) {
      // 400 with the code so the UI can localize / branch. The message
      // is already user-facing (we wrote it that way in users.ts).
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 400 },
      );
    }
    console.warn("[auth signup failed]", {
      err: (err as Error).message,
    });
    return NextResponse.json(
      { error: "Couldn't create your account. Try again." },
      { status: 500 },
    );
  }

  // Carry over any anonymous votes this browser cast.
  try {
    await reconcileVotesForCookieToken(user.id);
  } catch (err) {
    console.warn("[auth signup reconcile-failed]", {
      user_id_hash: hashForLog(user.id),
      err: (err as Error).message,
    });
  }

  await createUserSession({
    userId: user.id,
    email: user.email,
    role: "user",
  });

  console.info("[auth signup ok]", { user_id_hash: hashForLog(user.id) });
  return NextResponse.json({ ok: true, next: next ?? "/" });
}
