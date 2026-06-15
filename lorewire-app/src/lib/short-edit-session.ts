// Edit-session concurrency primitive for the short editor.
//
// Phase 5 of _plans/2026-06-16-short-editor-full-parity.md. Direct port of
// the video editor's lib/edit-session.ts pattern: the editor stamps
// `_edit_session = {user_id, started_at, heartbeat_at}` onto the short
// config on mount, then refreshes `heartbeat_at` on a 30 s timer. The
// page's server render uses isSessionForeign() to decide whether the
// banner should fire and the actions are read-only.
//
// Stale window: 2 min (4 missed heartbeats at 30 s). Wide enough to
// survive a brief tab switch / wifi blip; tight enough that a closed tab
// frees the session before the user gets back from coffee.
//
// NOTE: this module deliberately does NOT carry `import "server-only"`.
// SHORT_EDIT_HEARTBEAT_INTERVAL_MS is consumed by ShortEditorClient (a
// client component) and the two pure functions below have no server
// side-effects (no DB, no auth) — they are safe to bundle into the
// client even if a caller happens to reach them there. The 2026-06-15
// Phase 5 PR shipped with server-only and broke Vercel's prod build
// because Turbopack honours that directive across client component
// import graphs even when the caller only takes a constant.

import type { ShortConfig, ShortEditSession } from "@/lib/short-config";

/** A session whose heartbeat_at is older than this is stale — another
 *  admin can take over without seeing the banner. Matches the video
 *  editor's window so the two editors behave the same way. */
export const SHORT_EDIT_SESSION_STALE_MS = 2 * 60 * 1000;

/** How often the client bumps heartbeat_at. The action body intentionally
 *  doesn't read this — it's just a constant the EditorClient hook uses. */
export const SHORT_EDIT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface ForeignSessionRead {
  /** True when the session is foreign AND still fresh (heartbeat within
   *  SHORT_EDIT_SESSION_STALE_MS). Drives the banner and the read-only
   *  state in the client. */
  isForeign: boolean;
  /** The other admin's user_id if foreign; null otherwise. The action layer
   *  uses this to attribute the conflict in logs; the page maps it to an
   *  email for the banner copy. */
  foreignUserId: string | null;
}

export function readForeignSession(
  config: ShortConfig,
  currentUserId: string,
  nowMs: number = Date.now(),
): ForeignSessionRead {
  const session = config._edit_session;
  if (!session) return { isForeign: false, foreignUserId: null };
  if (session.user_id === currentUserId) {
    return { isForeign: false, foreignUserId: null };
  }
  const heartbeatMs = Date.parse(session.heartbeat_at);
  if (Number.isNaN(heartbeatMs)) {
    // Malformed timestamp → treat as stale rather than blocking edits.
    return { isForeign: false, foreignUserId: null };
  }
  const age = nowMs - heartbeatMs;
  if (age > SHORT_EDIT_SESSION_STALE_MS) {
    return { isForeign: false, foreignUserId: session.user_id };
  }
  return { isForeign: true, foreignUserId: session.user_id };
}

// Build the next-config snapshot for a claim or a heartbeat bump. Pure so
// the action layer can call this then persist via setStoryShortConfigJson.
export function nextSessionFor(
  config: ShortConfig,
  userId: string,
  kind: "claim" | "heartbeat",
  nowIso: string,
): ShortConfig {
  const existing = config._edit_session;
  const session: ShortEditSession = {
    user_id: userId,
    started_at:
      kind === "heartbeat" && existing && existing.user_id === userId
        ? existing.started_at
        : nowIso,
    heartbeat_at: nowIso,
  };
  return { ...config, _edit_session: session };
}
