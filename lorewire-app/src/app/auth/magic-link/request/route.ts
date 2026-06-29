// POST /auth/magic-link/request — user submits email; we email them a
// one-time sign-in link.
//
// Response always reads the same to the client whether the email exists
// or not. We do NOT distinguish "user exists" from "user doesn't exist"
// in the response shape — account-enumeration leak. The 200 just says
// "if that email is valid, a link is on the way", and the UI displays
// the same confirmation either way.
//
// Rate limit: per (ip, email-hash). Borrows the same primitive the polls
// vote route uses (lib/poll-rate-limit). 1 request per minute, 5 per
// hour — generous enough for "I didn't get the email, try again" but
// tight enough to throttle abuse.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md.

import { NextResponse, type NextRequest } from "next/server";

import {
  checkAndRecord,
  ipUaHash,
  DEFAULT_PER_HOUR,
  DEFAULT_PER_MINUTE,
} from "@/lib/poll-rate-limit";
import { issueMagicLink, sendMagicLinkEmail } from "@/lib/magic-link";
import { sanitizeNext } from "@/lib/oauth-cookies";
import { normalizeEmail } from "@/lib/users";

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
      "[auth magic-link] NEXT_PUBLIC_SITE_ORIGIN unset in production — every request will be rejected.",
    );
  }
  return false;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface RequestBody {
  email?: unknown;
  next?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    console.warn("[auth magic-link origin-rejected]", {
      origin: req.headers.get("origin"),
      site_origin_set: Boolean(process.env.NEXT_PUBLIC_SITE_ORIGIN),
    });
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const rawEmail = typeof body.email === "string" ? body.email : "";
  const email = normalizeEmail(rawEmail);
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }
  const next = sanitizeNext(typeof body.next === "string" ? body.next : null);

  // Rate-limit by (ip, email-hash) so a single attacker can't burn
  // through every email in their list from one IP.
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const limitKey = ipUaHash(ip || null, email);
  const limit = checkAndRecord(limitKey);
  if (!limit.ok) {
    console.warn("[auth magic-link rate-limit]", {
      in_minute: limit.inMinute,
      in_hour: limit.inHour,
      per_minute: DEFAULT_PER_MINUTE,
      per_hour: DEFAULT_PER_HOUR,
    });
    // Same 200 shape as success — no enumeration leak via 429 either.
    // The retry-after header still informs honest UIs that want to
    // debounce; abusers see no differential signal.
    return NextResponse.json(
      { ok: true, message: "If the email is valid, a link is on the way." },
      { headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  // Always issue + send. Even if no user row exists for the email yet,
  // verify will create one on click. This is the "no enumeration leak"
  // path — the response shape is identical whether the user is known.
  const issued = await issueMagicLink(email);
  const origin =
    process.env.NEXT_PUBLIC_SITE_ORIGIN?.replace(/\/$/, "") ??
    req.nextUrl.origin;
  const linkUrl = new URL("/auth/magic-link/verify", origin);
  linkUrl.searchParams.set("token", issued.token);
  if (next) linkUrl.searchParams.set("next", next);

  const send = await sendMagicLinkEmail(email, linkUrl.toString());
  if (!send.ok) {
    // Don't surface the cause to the client — but log loudly so a
    // misconfigured BREVO_API_KEY shows up in ops.
    console.warn("[auth magic-link send-failed]", { error: send.error });
  } else {
    console.info("[auth magic-link sent]", {
      message_id: send.messageId,
      expires_at: issued.expiresAt.toISOString(),
    });
  }

  return NextResponse.json({
    ok: true,
    message: "If the email is valid, a link is on the way.",
  });
}
