// POST /api/user/export — self-serve data export (GDPR Article 15 access /
// Article 20 portability). Returns everything LoreWire holds about the
// signed-in user as JSON; the client offers it as a download plus a readable
// summary.
//
// POST (not GET) so the response is never cached, bookmarked, or logged in a
// shared URL, and so the same-origin gate applies. The active lw_user session
// is the identity proof — this only ever returns the session-owner's own data
// (exportUserData is scoped to session.userId), never an id from the request.
//
// Plan: _plans/2026-06-22-gdpr-compliance.md §Phase 2.

import { NextResponse, type NextRequest } from "next/server";

import { exportUserData } from "@/lib/personal-data";
import { isSameOrigin } from "@/lib/request-origin";
import { readUserSession } from "@/lib/user-session";
import { getUserById, hashForLog } from "@/lib/users";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isSameOrigin(req)) {
    console.warn("[user export origin-rejected]", {
      received_origin: req.headers.get("origin"),
      expected_origin: process.env.NEXT_PUBLIC_SITE_ORIGIN ?? null,
    });
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  const session = await readUserSession();
  if (!session) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const user = await getUserById(session.userId);
  if (!user) {
    // Session points at a deleted row — treat as signed out.
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  try {
    const data = await exportUserData(user);
    console.info("[user export ok]", { user_id_hash: hashForLog(user.id) });
    // No-store: the body is the user's personal data; never let a proxy or
    // the browser cache cache it.
    return NextResponse.json(
      { ok: true, export: data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.warn("[user export failed]", {
      user_id_hash: hashForLog(user.id),
      err: (err as Error).message,
    });
    return NextResponse.json(
      { error: "Couldn't build your export. Try again in a moment." },
      { status: 500 },
    );
  }
}
