// Shared same-origin gate for public POST endpoints. Factored out of the
// engagement-poll vote route (src/app/api/polls/vote/route.ts) so the comments
// write path enforces the identical rule rather than a second hand-rolled copy.
//
// Security (rule 13): a cross-site script in another tab must not be able to
// fire a state-changing POST. Vercel always attaches an Origin header on
// cross-origin POSTs, so checking it against NEXT_PUBLIC_SITE_ORIGIN is the
// conservative default. Fail closed in production: if the env var is unset,
// reject (and warn once per instance so a misconfigured deploy is visible in
// logs instead of silently rejecting every write).

import "server-only";
import type { NextRequest } from "next/server";

let warnedMissingOriginInProd = false;

export function isAllowedOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) {
    // No Origin header: a same-origin context that didn't attach one (older
    // browsers, some bots). Accept only in dev; production POSTs without an
    // Origin are rejected.
    return process.env.NODE_ENV !== "production";
  }
  const expected = process.env.NEXT_PUBLIC_SITE_ORIGIN?.trim() ?? "";
  if (expected) {
    return origin === expected.replace(/\/$/, "");
  }
  // No configured origin: dev fallback to localhost only.
  if (process.env.NODE_ENV !== "production") {
    return (
      /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)
    );
  }
  // Prod + NEXT_PUBLIC_SITE_ORIGIN unset = every write 403'd. Fail closed is
  // correct, but surface it once so the deploy hygiene case is debuggable.
  if (!warnedMissingOriginInProd) {
    warnedMissingOriginInProd = true;
    console.warn(
      "[request-origin] NEXT_PUBLIC_SITE_ORIGIN is unset in production — every POST will be rejected. Set it to the canonical site origin (e.g. https://lorewire.com).",
    );
  }
  return false;
}
