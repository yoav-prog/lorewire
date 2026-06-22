// Same-origin gate for public-user mutation routes (CSRF defense in depth on
// top of the SameSite=Lax session cookie). Factored out of the inline copy
// that /api/auth/login, /api/auth/signup, and /api/user/profile each carry;
// the new data-subject routes use this instead of pasting a fourth copy.
// Those three could adopt it later — left untouched here to keep this change
// scoped to the GDPR work.
//
// Production: the request must carry an Origin header equal to
// NEXT_PUBLIC_SITE_ORIGIN (trailing slash ignored). Fails closed when that
// env var is unset in production. Dev: a missing Origin is allowed and
// localhost / 127.0.0.1 origins pass.

import type { NextRequest } from "next/server";

let warnedMissingSiteOrigin = false;

export function isSameOrigin(req: NextRequest): boolean {
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
  if (!warnedMissingSiteOrigin) {
    warnedMissingSiteOrigin = true;
    console.warn(
      "[request-origin] NEXT_PUBLIC_SITE_ORIGIN unset in production — every origin-gated POST will be rejected.",
    );
  }
  return false;
}
