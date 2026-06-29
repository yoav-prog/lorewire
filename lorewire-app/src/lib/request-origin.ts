// Shared same-origin gate for public POST endpoints and public-user mutation
// routes (CSRF defense in depth on top of the SameSite=Lax session cookie).
// Two parts of the app converged on the same check from different sides: the
// GDPR data-subject routes adopted it as isSameOrigin, the comments write path
// as isAllowedOrigin. They are the same gate, so one implementation backs both
// exported names and neither call site has to change.
//
// Security (rule 13): a cross-site script in another tab must not be able to
// fire a state-changing POST. Vercel always attaches an Origin header on
// cross-origin POSTs, so checking it against NEXT_PUBLIC_SITE_ORIGIN is the
// conservative default. Fail closed in production: if the env var is unset,
// reject every origin-gated POST (and warn once per instance so a misconfigured
// deploy is visible in logs instead of silently rejecting every write). Dev: a
// missing Origin is allowed and localhost / 127.0.0.1 origins pass.

import "server-only";
import type { NextRequest } from "next/server";

let warnedMissingSiteOrigin = false;

export function isSameOrigin(req: NextRequest): boolean {
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
  if (process.env.NODE_ENV !== "production") {
    return (
      /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)
    );
  }
  // Prod + NEXT_PUBLIC_SITE_ORIGIN unset means every origin-gated write is
  // 403'd. Failing closed is correct, but surface it once so the deploy-hygiene
  // case is debuggable instead of a silent wall of rejections.
  if (!warnedMissingSiteOrigin) {
    warnedMissingSiteOrigin = true;
    console.warn(
      "[request-origin] NEXT_PUBLIC_SITE_ORIGIN is unset in production. Every origin-gated POST will be rejected; set it to the canonical site origin (e.g. https://lorewire.com).",
    );
  }
  return false;
}

/** Alias kept for the comments write path, which adopted this gate under the
 *  name isAllowedOrigin. Identical behavior; one implementation, two names so
 *  neither call site has to change. */
export const isAllowedOrigin = isSameOrigin;
