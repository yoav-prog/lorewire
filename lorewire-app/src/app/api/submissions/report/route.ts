// POST /api/submissions/report — public "this is about me / report" path for a
// published submission story. Unauthenticated (a victim has no account); bounded
// by an origin gate plus an hourly cap per reporter bucket (lib/submission-reports).
//
// Plan: _plans/2026-06-29-user-submitted-stories.md (Phase 4).

import { NextResponse, type NextRequest } from "next/server";

import { ipUaHash } from "@/lib/poll-rate-limit";
import { createSubmissionReport } from "@/lib/submission-reports";

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
  return false;
}

interface ReportBody {
  storyId?: unknown;
  reason?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  let body: ReportBody;
  try {
    body = (await req.json()) as ReportBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const storyId = typeof body.storyId === "string" ? body.storyId.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason : "";
  if (!storyId) {
    return NextResponse.json({ error: "missing storyId" }, { status: 400 });
  }

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const ua = req.headers.get("user-agent") ?? "";
  const hash = ipUaHash(ip || null, ua || null);

  const res = await createSubmissionReport({ storyId, reason, ipUaHash: hash });
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
