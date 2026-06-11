// Tests for classifyEditSession — the pure rule that drives the editor's
// concurrency banner. Keeping it pure (no DB, no fetch) means the page can
// call it inline during server render without any await dance.

import { describe, expect, it } from "vitest";
import { classifyEditSession, STALE_SESSION_MS } from "@/lib/edit-session";

const NOW = Date.parse("2026-06-11T12:00:00Z");

function session(
  user_id: string,
  heartbeatOffsetMs: number,
): { user_id: string; started_at: string; heartbeat_at: string } {
  return {
    user_id,
    started_at: new Date(NOW - heartbeatOffsetMs).toISOString(),
    heartbeat_at: new Date(NOW - heartbeatOffsetMs).toISOString(),
  };
}

describe("classifyEditSession", () => {
  it("returns 'none' when no session field is set", () => {
    expect(classifyEditSession(undefined, "me", NOW).kind).toBe("none");
  });

  it("returns 'own' when the session's user_id matches the current admin", () => {
    expect(
      classifyEditSession(session("me", 5_000), "me", NOW).kind,
    ).toBe("own");
  });

  it("returns 'foreign-active' for a fresh foreign session", () => {
    const r = classifyEditSession(session("other", 5_000), "me", NOW);
    expect(r.kind).toBe("foreign-active");
    expect(r.ownerUserId).toBe("other");
  });

  it("returns 'stale' when a foreign session is past the heartbeat threshold", () => {
    const r = classifyEditSession(
      session("other", STALE_SESSION_MS + 1),
      "me",
      NOW,
    );
    expect(r.kind).toBe("stale");
    expect(r.ownerUserId).toBe("other");
  });

  it("returns 'stale' on a malformed heartbeat timestamp", () => {
    // A bad ISO string parses to NaN — we treat that as definitely-stale
    // so the banner doesn't trip on corrupted JSON.
    const r = classifyEditSession(
      {
        user_id: "other",
        started_at: "garbage",
        heartbeat_at: "garbage",
      },
      "me",
      NOW,
    );
    expect(r.kind).toBe("stale");
  });

  it("treats a session exactly at the threshold as still fresh", () => {
    // Boundary: heartbeat exactly at STALE_SESSION_MS old means age ===
    // threshold, classified as foreign-active (the strict `>` comparison
    // in classifyEditSession). A consistent rule across runs is what we
    // want — pick fresh-or-stale once and lock it.
    const r = classifyEditSession(
      session("other", STALE_SESSION_MS),
      "me",
      NOW,
    );
    expect(r.kind).toBe("foreign-active");
  });
});
