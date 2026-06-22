// Public-side user session SHIM.
//
// The Comments feature was written against a public-user session
// (`lw_user` JWT cookie) that lives in the anonymous-first auth plan
// (_plans/2026-06-19-anonymous-first-auth.md). That auth surface is
// not on `main` yet — it's in flight on
// `feat/multi-platform-shorts-publisher`.
//
// Until the real public session ships, this shim keeps the comments
// code typecheck-clean and runtime-safe by always returning `null`.
// Every code path in the comments routes that reads `readUserSession`
// already handles the null case (guest fallback). When the real
// surface lands, swap this file's contents for the proper JWT-cookie
// implementation — the comments code itself does not need to change.
//
// Plan: _plans/2026-06-22-comments-feature-restoration.md.

import "server-only";

export interface UserSessionData {
  userId: string;
  email: string;
  role: "user";
}

export async function readUserSession(): Promise<UserSessionData | null> {
  return null;
}
