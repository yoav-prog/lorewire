// POST /api/auth/login — email + password sign-in for an existing
// account. Same origin gate + same response shape as /api/auth/signup;
// the UI uses different copy ("Sign in" vs "Create account") but the
// underlying contract is symmetric.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §UI surfaces.

import { NextResponse, type NextRequest } from "next/server";

import { sanitizeNext } from "@/lib/oauth-cookies";
import { createUserSession } from "@/lib/user-session";
import {
  hashForLog,
  PublicAuthError,
  verifyPasswordLogin,
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
      "[auth login] NEXT_PUBLIC_SITE_ORIGIN unset in production — every login will be rejected.",
    );
  }
  return false;
}

interface LoginBody {
  email?: unknown;
  password?: unknown;
  next?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    console.warn("[auth login origin-rejected]", {
      received_origin: req.headers.get("origin"),
      expected_origin: process.env.NEXT_PUBLIC_SITE_ORIGIN ?? null,
    });
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  let body: LoginBody;
  try {
    body = (await req.json()) as LoginBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  const next = sanitizeNext(typeof body.next === "string" ? body.next : null);

  let user;
  try {
    user = await verifyPasswordLogin(email, password);
  } catch (err) {
    if (err instanceof PublicAuthError) {
      // Both "unknown email" and "wrong password" map to the same code
      // here on purpose (see lib/users.ts:verifyPasswordLogin) so the
      // response shape doesn't leak account existence.
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === "bad_credentials" ? 401 : 400 },
      );
    }
    console.warn("[auth login failed]", { err: (err as Error).message });
    return NextResponse.json(
      { error: "Couldn't sign you in. Try again." },
      { status: 500 },
    );
  }

  await createUserSession({
    userId: user.id,
    email: user.email,
    role: "user",
  });

  console.info("[auth login ok]", { user_id_hash: hashForLog(user.id) });
  return NextResponse.json({ ok: true, next: next ?? "/" });
}
