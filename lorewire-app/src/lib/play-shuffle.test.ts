// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import {
  pickRandomPlayable,
  pushShuffleRecent,
  readShuffleRecents,
} from "./play-shuffle";

const story = (id: string, withVideo: boolean) => ({
  id,
  videoUrl: withVideo ? `https://example.test/${id}.mp4` : undefined,
});

// Deterministic rng: always picks the first entry of the candidate pool.
const firstRng = () => 0;
// Deterministic rng: always picks the last entry of the candidate pool.
const lastRng = () => 0.9999;

describe("pickRandomPlayable", () => {
  it("returns null when no story has a videoUrl", () => {
    const result = pickRandomPlayable({
      catalog: [story("a", false), story("b", false)],
      rng: firstRng,
    });
    expect(result).toBeNull();
  });

  it("returns the only playable story when the pool is a single entry", () => {
    const result = pickRandomPlayable({
      catalog: [story("a", false), story("b", true), story("c", false)],
      rng: firstRng,
    });
    expect(result).toBe("b");
  });

  it("excludes the current hero from the pool", () => {
    const result = pickRandomPlayable({
      catalog: [story("hero", true), story("b", true), story("c", true)],
      currentHeroId: "hero",
      rng: firstRng,
    });
    expect(result).toBe("b");
  });

  it("excludes recently-shuffled ids on top of the hero exclusion", () => {
    const result = pickRandomPlayable({
      catalog: [
        story("hero", true),
        story("r1", true),
        story("r2", true),
        story("fresh", true),
      ],
      currentHeroId: "hero",
      recentIds: ["r1", "r2"],
      rng: firstRng,
    });
    expect(result).toBe("fresh");
  });

  it("falls back to layer 2 (hero-only exclusion) when recents drain the pool", () => {
    const result = pickRandomPlayable({
      catalog: [story("hero", true), story("r1", true), story("r2", true)],
      currentHeroId: "hero",
      recentIds: ["r1", "r2"],
      rng: firstRng,
    });
    // layer 1 = [] (everything excluded), layer 2 = [r1, r2], firstRng → r1
    expect(result).toBe("r1");
  });

  it("falls back to layer 3 (return hero) when only the hero is playable", () => {
    const result = pickRandomPlayable({
      catalog: [story("hero", true), story("b", false), story("c", false)],
      currentHeroId: "hero",
      recentIds: ["r1"],
      rng: firstRng,
    });
    expect(result).toBe("hero");
  });

  it("returns null on a fully empty catalog", () => {
    const result = pickRandomPlayable({ catalog: [], rng: firstRng });
    expect(result).toBeNull();
  });

  it("clamps the rng index so 0.9999 never reads off the end", () => {
    const result = pickRandomPlayable({
      catalog: [story("a", true), story("b", true), story("c", true)],
      rng: lastRng,
    });
    expect(result).toBe("c");
  });

  it("ignores recents that aren't in the catalog (stale ids don't poison the pool)", () => {
    const result = pickRandomPlayable({
      catalog: [story("a", true), story("b", true)],
      currentHeroId: null,
      recentIds: ["ghost1", "ghost2"],
      rng: firstRng,
    });
    expect(result).toBe("a");
  });
});

describe("sessionStorage recents", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("reads empty when nothing has been written", () => {
    expect(readShuffleRecents()).toEqual([]);
  });

  it("round-trips a pushed id", () => {
    pushShuffleRecent("a");
    expect(readShuffleRecents()).toEqual(["a"]);
  });

  it("most-recent-first order", () => {
    pushShuffleRecent("a");
    pushShuffleRecent("b");
    pushShuffleRecent("c");
    expect(readShuffleRecents()).toEqual(["c", "b", "a"]);
  });

  it("dedupes when the same id is pushed twice", () => {
    pushShuffleRecent("a");
    pushShuffleRecent("b");
    pushShuffleRecent("a");
    expect(readShuffleRecents()).toEqual(["a", "b"]);
  });

  it("caps at 3 entries", () => {
    pushShuffleRecent("a");
    pushShuffleRecent("b");
    pushShuffleRecent("c");
    pushShuffleRecent("d");
    expect(readShuffleRecents()).toEqual(["d", "c", "b"]);
  });

  it("recovers from corrupt JSON in storage", () => {
    window.sessionStorage.setItem("lw_shuffle_recents", "{not json");
    expect(readShuffleRecents()).toEqual([]);
  });

  it("recovers from a non-array payload", () => {
    window.sessionStorage.setItem("lw_shuffle_recents", '{"a":1}');
    expect(readShuffleRecents()).toEqual([]);
  });

  it("filters non-string entries out of the stored array", () => {
    window.sessionStorage.setItem(
      "lw_shuffle_recents",
      JSON.stringify(["a", 42, null, "b"]),
    );
    expect(readShuffleRecents()).toEqual(["a", "b"]);
  });
});
