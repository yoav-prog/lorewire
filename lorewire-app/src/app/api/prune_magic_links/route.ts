// Vercel cron: prune expired / consumed magic-link tokens.
//
// magic_link_tokens rows carry the requester's email. A token is dead 15
// minutes after issue (or the moment it's used), so keeping the row past that
// is residual personal data with no purpose. pruneExpiredMagicLinks already
// existed in lib/magic-link.ts but was never called ("wire it to a cron" was a
// standing TODO); this is that cron. It also closes the gap where a deleted
// account's leftover tokens would otherwise linger: those tokens expire within
// 15 minutes and are then removed here.
//
// Auth: CRON_SECRET Bearer, identical to /api/polls/refresh and the drains.
//
// Plan: _plans/2026-06-22-gdpr-compliance.md §Phase 3.

import { NextResponse, type NextRequest } from "next/server";

import { pruneExpiredMagicLinks } from "@/lib/magic-link";

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  return header === `Bearer ${expected}`;
}

async function serve(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const pruned = await pruneExpiredMagicLinks();
    console.info("[magic-link prune cron]", { pruned });
    return NextResponse.json({ pruned });
  } catch (err) {
    console.warn("[magic-link prune cron] failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "prune failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export const maxDuration = 60;
