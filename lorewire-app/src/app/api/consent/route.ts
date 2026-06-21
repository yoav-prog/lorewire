// POST /api/consent — set the cookie-consent state for this browser.
//
// Called by:
//   - Banner Accept / Reject clicks (src/components/CookieConsent.tsx).
//   - Footer "Manage cookies" → re-opened banner.
//   - Client-side grandfather path: if the user already has persisted state
//     (lw.saved.v1, lw.liked.v1, or the lw_vote cookie) we silently POST
//     "accepted" on first run so existing users don't see a retroactive
//     banner. See plan §Cookie consent · First-run grandfather.
//
// The body is shape-validated; bad payloads → 400, never a Set-Cookie.
// Same-origin gate mirrors /api/polls/vote — defense against a malicious
// site flipping a user's consent state via cross-origin POST. CSRF risk is
// low (the cookie is non-secret) but the gate is cheap insurance.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md.

import { NextResponse, type NextRequest } from "next/server";
import { setConsent, type ConsentValue } from "@/lib/consent";

interface ConsentBody {
  value?: unknown;
}

let warnedAboutMissingSiteOriginInProd = false;

function isAllowedOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) {
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
  if (!warnedAboutMissingSiteOriginInProd) {
    warnedAboutMissingSiteOriginInProd = true;
    console.warn(
      "[consent] NEXT_PUBLIC_SITE_ORIGIN is unset in production — every consent POST will be rejected. Set the env var to the canonical site origin.",
    );
  }
  return false;
}

function parseValue(raw: unknown): ConsentValue | null {
  return raw === "accepted" || raw === "rejected" ? raw : null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    // 2026-06-21: log the actual expected origin so a www-vs-apex or
    // trailing-whitespace mismatch is visible in Vercel logs without
    // requiring code edits to diagnose. Same logging shape as
    // /api/polls/vote — the env var is NEXT_PUBLIC so it's not secret.
    console.warn("[consent origin-rejected]", {
      received_origin: req.headers.get("origin"),
      expected_origin: process.env.NEXT_PUBLIC_SITE_ORIGIN ?? null,
      node_env: process.env.NODE_ENV,
    });
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  let body: ConsentBody;
  try {
    body = (await req.json()) as ConsentBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const value = parseValue(body.value);
  if (!value) {
    return NextResponse.json(
      { error: "value must be 'accepted' or 'rejected'" },
      { status: 400 },
    );
  }

  const result = await setConsent(value);
  console.info("[consent set]", {
    value: result.value,
    anon_issued: result.anonToken !== null,
  });
  return NextResponse.json({ ok: true, value: result.value });
}
