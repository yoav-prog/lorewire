// Coverage for the Phase 1 story-events recorder. Covers the consent
// gate, weight bake, anon-id capture, per-event rate limit, and
// rejection of unknown event types. Uses next/headers mock the same
// way impersonation.test.ts does so we can flip cookies between cases.

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      store.has(name) ? { value: store.get(name) } : undefined,
    getAll: () =>
      Array.from(store.entries()).map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => {
      store.set(name, value);
    },
    delete: (name: string) => {
      store.delete(name);
    },
  }),
}));

import {
  STORY_EVENT_WEIGHTS,
  _readEventsForTests,
  _resetRateLimitForTests,
  recordStoryEvent,
} from "./story-events";

const ANON = "a".repeat(64);

beforeEach(() => {
  store.clear();
  _resetRateLimitForTests();
});

describe("recordStoryEvent — consent gate", () => {
  it("drops the event when no consent cookie is present", async () => {
    const r = await recordStoryEvent({
      storyId: "story-1",
      type: "play_completed",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("consent_rejected");
    const rows = await _readEventsForTests("story-1");
    expect(rows).toHaveLength(0);
  });

  it("drops the event when consent is rejected", async () => {
    store.set("lw_consent", "rejected");
    const r = await recordStoryEvent({
      storyId: "story-1",
      type: "play_completed",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("consent_rejected");
  });

  it("writes the event when consent is accepted", async () => {
    store.set("lw_consent", "accepted");
    store.set("lw_anon", ANON);
    const r = await recordStoryEvent({
      storyId: "story-2",
      type: "play_completed",
    });
    expect(r.ok).toBe(true);
    const rows = await _readEventsForTests("story-2");
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("play_completed");
    expect(rows[0].anon_id).toBe(ANON);
  });
});

describe("recordStoryEvent — weight bake", () => {
  beforeEach(() => {
    store.set("lw_consent", "accepted");
    store.set("lw_anon", ANON);
  });

  it("bakes the per-type weight into the row at write time", async () => {
    for (const [type, weight] of Object.entries(STORY_EVENT_WEIGHTS)) {
      const r = await recordStoryEvent({
        storyId: `story-${type}`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: type as any,
      });
      expect(r.ok).toBe(true);
      const rows = await _readEventsForTests(`story-${type}`);
      expect(rows).toHaveLength(1);
      expect(rows[0].weight).toBe(weight);
    }
  });
});

describe("recordStoryEvent — anon id", () => {
  it("records the lw_anon cookie value on the row", async () => {
    store.set("lw_consent", "accepted");
    store.set("lw_anon", ANON);
    await recordStoryEvent({ storyId: "story-3", type: "save_added" });
    const rows = await _readEventsForTests("story-3");
    expect(rows[0].anon_id).toBe(ANON);
  });

  it("stores NULL when consent is accepted but the anon cookie is missing", async () => {
    store.set("lw_consent", "accepted");
    await recordStoryEvent({ storyId: "story-4", type: "save_added" });
    const rows = await _readEventsForTests("story-4");
    expect(rows[0].anon_id).toBeNull();
  });
});

describe("recordStoryEvent — rate limit", () => {
  beforeEach(() => {
    store.set("lw_consent", "accepted");
    store.set("lw_anon", ANON);
  });

  it("allows the first 60 events in a window", async () => {
    for (let i = 0; i < 60; i++) {
      const r = await recordStoryEvent({
        storyId: `story-rate-${i}`,
        type: "play_started",
      });
      expect(r.ok).toBe(true);
    }
  });

  it("drops the 61st event with reason=rate_limited", async () => {
    for (let i = 0; i < 60; i++) {
      await recordStoryEvent({
        storyId: `story-rate-${i}`,
        type: "play_started",
      });
    }
    const r = await recordStoryEvent({
      storyId: "story-rate-overflow",
      type: "play_started",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("rate_limited");
  });
});

describe("recordStoryEvent — input validation", () => {
  beforeEach(() => {
    store.set("lw_consent", "accepted");
    store.set("lw_anon", ANON);
  });

  it("rejects an unknown event type", async () => {
    const r = await recordStoryEvent({
      storyId: "story-5",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: "not_a_real_type" as any,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_type");
    const rows = await _readEventsForTests("story-5");
    expect(rows).toHaveLength(0);
  });

  it("rejects an empty story id", async () => {
    const r = await recordStoryEvent({
      storyId: "",
      type: "save_added",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_type");
  });
});
