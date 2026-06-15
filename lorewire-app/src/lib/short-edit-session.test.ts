// Tests for the edit-session helpers (Phase 5 of the short editor plan).
// Pure functions — no DB, no React. The action layer's DB writes are
// straightforward wrappers; the load-bearing logic is here.

import { describe, expect, it } from "vitest";
import {
  SHORT_EDIT_SESSION_STALE_MS,
  nextSessionFor,
  readForeignSession,
} from "@/lib/short-edit-session";
import {
  CURRENT_SHORT_CONFIG_VERSION,
  type ShortConfig,
} from "@/lib/short-config";

function configWith(session: ShortConfig["_edit_session"]): ShortConfig {
  return {
    config_version: CURRENT_SHORT_CONFIG_VERSION,
    doodle_frames: [],
    captions: [],
    ...(session ? { _edit_session: session } : {}),
  };
}

describe("readForeignSession", () => {
  it("returns not-foreign when no session exists", () => {
    const r = readForeignSession(configWith(undefined), "alice");
    expect(r).toEqual({ isForeign: false, foreignUserId: null });
  });

  it("returns not-foreign when the current user owns the session", () => {
    const now = Date.parse("2026-06-16T12:00:00.000Z");
    const r = readForeignSession(
      configWith({
        user_id: "alice",
        started_at: "2026-06-16T11:00:00.000Z",
        heartbeat_at: "2026-06-16T11:59:55.000Z",
      }),
      "alice",
      now,
    );
    expect(r.isForeign).toBe(false);
    expect(r.foreignUserId).toBeNull();
  });

  it("returns foreign+id when another user owns a fresh session", () => {
    const now = Date.parse("2026-06-16T12:00:00.000Z");
    const r = readForeignSession(
      configWith({
        user_id: "bob",
        started_at: "2026-06-16T11:00:00.000Z",
        heartbeat_at: "2026-06-16T11:59:00.000Z",
      }),
      "alice",
      now,
    );
    expect(r.isForeign).toBe(true);
    expect(r.foreignUserId).toBe("bob");
  });

  it("returns not-foreign when another user's session has gone stale", () => {
    const now = Date.parse("2026-06-16T12:00:00.000Z");
    // Heartbeat older than the stale window.
    const heartbeat = new Date(now - SHORT_EDIT_SESSION_STALE_MS - 1).toISOString();
    const r = readForeignSession(
      configWith({
        user_id: "bob",
        started_at: heartbeat,
        heartbeat_at: heartbeat,
      }),
      "alice",
      now,
    );
    expect(r.isForeign).toBe(false);
    // foreignUserId is still surfaced so the action layer can log the
    // takeover attribution; only the banner suppression is the load-bearing
    // contract here.
    expect(r.foreignUserId).toBe("bob");
  });

  it("treats heartbeat exactly at the stale boundary as fresh", () => {
    const now = Date.parse("2026-06-16T12:00:00.000Z");
    const heartbeat = new Date(now - SHORT_EDIT_SESSION_STALE_MS).toISOString();
    const r = readForeignSession(
      configWith({
        user_id: "bob",
        started_at: heartbeat,
        heartbeat_at: heartbeat,
      }),
      "alice",
      now,
    );
    expect(r.isForeign).toBe(true);
  });

  it("treats a malformed timestamp as not-foreign so edits don't block", () => {
    const r = readForeignSession(
      configWith({
        user_id: "bob",
        started_at: "not a date",
        heartbeat_at: "still not a date",
      }),
      "alice",
    );
    expect(r.isForeign).toBe(false);
  });
});

describe("nextSessionFor", () => {
  it("on claim sets started_at = heartbeat_at = now even if a session existed", () => {
    const existing = configWith({
      user_id: "bob",
      started_at: "2025-01-01T00:00:00.000Z",
      heartbeat_at: "2025-01-01T00:00:00.000Z",
    });
    const next = nextSessionFor(existing, "alice", "claim", "2026-06-16T12:00:00.000Z");
    expect(next._edit_session).toEqual({
      user_id: "alice",
      started_at: "2026-06-16T12:00:00.000Z",
      heartbeat_at: "2026-06-16T12:00:00.000Z",
    });
  });

  it("on heartbeat preserves started_at when the same user owns the session", () => {
    const existing = configWith({
      user_id: "alice",
      started_at: "2026-06-16T11:00:00.000Z",
      heartbeat_at: "2026-06-16T11:30:00.000Z",
    });
    const next = nextSessionFor(existing, "alice", "heartbeat", "2026-06-16T12:00:00.000Z");
    expect(next._edit_session).toEqual({
      user_id: "alice",
      started_at: "2026-06-16T11:00:00.000Z", // preserved
      heartbeat_at: "2026-06-16T12:00:00.000Z", // bumped
    });
  });

  it("on heartbeat treats a session owned by someone else as a fresh start", () => {
    const existing = configWith({
      user_id: "bob",
      started_at: "2026-06-16T11:00:00.000Z",
      heartbeat_at: "2026-06-16T11:30:00.000Z",
    });
    const next = nextSessionFor(existing, "alice", "heartbeat", "2026-06-16T12:00:00.000Z");
    // alice's session — started_at should be now, not bob's started_at.
    expect(next._edit_session?.user_id).toBe("alice");
    expect(next._edit_session?.started_at).toBe("2026-06-16T12:00:00.000Z");
  });

  it("preserves the rest of the config (no accidental clobbers)", () => {
    const base: ShortConfig = {
      config_version: CURRENT_SHORT_CONFIG_VERSION,
      doodle_frames: [
        { id: "f-00", url: "/a.png", caption_chunk_start_index: 0 },
      ],
      captions: [{ start_ms: 0, end_ms: 1000, text: "hi" }],
      script: "Hello",
    };
    const next = nextSessionFor(base, "alice", "claim", "2026-06-16T12:00:00.000Z");
    expect(next.doodle_frames).toEqual(base.doodle_frames);
    expect(next.captions).toEqual(base.captions);
    expect(next.script).toBe("Hello");
  });
});
