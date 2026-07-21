// @vitest-environment happy-dom

// Contract coverage for the session vote-overlay store. Tests the underlying
// mark-once primitive via __votedStoreForTests so we don't need a React
// renderer (no @testing-library set up — the same workaround the rest of the
// codebase uses).
//
// The store is in-memory only (no localStorage, no consent gate) — the server
// is the durable source of truth and re-seeds votedStoryIds on every load, so
// there is nothing here to persist or clear. Because it's additive with no
// reset, each test uses ids unique to itself so the module singleton can't
// leak state between cases; the "starts empty" case runs first, before any
// mark.

import { describe, expect, it } from "vitest";

import {
  __votedStoreForTests,
  markVotedStory,
  useVotedStories,
} from "./voted-stories";

describe("voted-stories module surface", () => {
  it("exposes useVotedStories + markVotedStory", () => {
    expect(typeof useVotedStories).toBe("function");
    expect(typeof markVotedStory).toBe("function");
  });

  it("getServerSnapshot returns a stable empty array (SSR-safe)", () => {
    // The SSR / first-paint snapshot must be empty so the seed carries prior
    // votes and there's no hydration mismatch.
    expect(__votedStoreForTests.getServerSnapshot()).toEqual([]);
    expect(__votedStoreForTests.getServerSnapshot()).toBe(
      __votedStoreForTests.getServerSnapshot(),
    );
  });
});

describe("voted-stories store — mark-once semantics", () => {
  it("starts empty", () => {
    const unsub = __votedStoreForTests.subscribe(() => {});
    expect(__votedStoreForTests.getSnapshot()).toEqual([]);
    unsub();
  });

  it("markVotedStory adds an id and has() reflects it", () => {
    const unsub = __votedStoreForTests.subscribe(() => {});
    markVotedStory("story-a");
    expect(__votedStoreForTests.has("story-a")).toBe(true);
    expect(__votedStoreForTests.getSnapshot()).toContain("story-a");
    unsub();
  });

  it("mark is idempotent — a second mark of the same id is a no-op", () => {
    let calls = 0;
    const unsub = __votedStoreForTests.subscribe(() => {
      calls += 1;
    });
    __votedStoreForTests.mark("story-dup");
    __votedStoreForTests.mark("story-dup");
    __votedStoreForTests.mark("story-dup");
    expect(calls).toBe(1);
    unsub();
  });

  it("ignores an empty-string id (defensive — article polls with no storyId)", () => {
    const before = __votedStoreForTests.getSnapshot().length;
    const unsub = __votedStoreForTests.subscribe(() => {});
    markVotedStory("");
    expect(__votedStoreForTests.has("")).toBe(false);
    expect(__votedStoreForTests.getSnapshot().length).toBe(before);
    unsub();
  });

  it("notifies subscribers once per newly-marked id", () => {
    let calls = 0;
    const unsub = __votedStoreForTests.subscribe(() => {
      calls += 1;
    });
    markVotedStory("notify-1"); // +1
    markVotedStory("notify-1"); // no-op
    markVotedStory("notify-2"); // +1
    expect(calls).toBe(2);
    unsub();
  });

  it("returns a stable snapshot reference between changes", () => {
    const unsub = __votedStoreForTests.subscribe(() => {});
    markVotedStory("stable-1");
    const snapA = __votedStoreForTests.getSnapshot();
    const snapB = __votedStoreForTests.getSnapshot();
    // No mutation between reads → same reference (useSyncExternalStore
    // relies on this to avoid an infinite render loop).
    expect(snapA).toBe(snapB);
    markVotedStory("stable-2");
    expect(__votedStoreForTests.getSnapshot()).not.toBe(snapA);
    unsub();
  });
});
