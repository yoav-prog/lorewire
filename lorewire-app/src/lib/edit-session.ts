// Pure helpers for the /admin/videos/[id] concurrency banner.
//
// Editor-only metadata `_edit_session` lives on the ShortVideoConfig as
// { user_id, started_at, heartbeat_at }. This module classifies that field
// against the current admin's identity into one of four buckets so the
// server page can pick a banner shape without each call site re-coding the
// staleness logic. Server actions (claimEditSession, heartbeatEditSession)
// are in app/admin/videos/[id]/actions.ts.

import type { ShortVideoConfig } from "@/lib/video-config";

// Heartbeat threshold for the banner. Sessions older than this are treated
// as stale (the editor lets the current admin claim without showing a
// "someone else is editing" banner). Mirrors the
// `video.editor.heartbeat_interval_ms` setting × 4 — heartbeats are every
// 30 s, so a true 2-minute gap is 4 missed beats.
export const STALE_SESSION_MS = 2 * 60 * 1000;

export interface EditSessionInfo {
  kind: "none" | "own" | "stale" | "foreign-active";
  ownerUserId?: string;
}

export function classifyEditSession(
  session: ShortVideoConfig["_edit_session"],
  currentUserId: string,
  nowMs: number = Date.now(),
): EditSessionInfo {
  if (!session) return { kind: "none" };
  if (session.user_id === currentUserId) return { kind: "own" };
  const heartbeatAge = nowMs - Date.parse(session.heartbeat_at);
  if (!Number.isFinite(heartbeatAge) || heartbeatAge > STALE_SESSION_MS) {
    return { kind: "stale", ownerUserId: session.user_id };
  }
  return { kind: "foreign-active", ownerUserId: session.user_id };
}
