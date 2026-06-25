// Pure-function coverage for the Stories rail playlist resolver.
// Mirrors the test fixture style used in lib/homepage-rails.test.ts
// (minimal Story objects cast through `as any`) so the same patterns
// are familiar across the codebase.

import { describe, expect, it } from "vitest";

import {
  STORIES_PLAYLIST_CAP,
  filterStoriesPlaylistByUnseen,
  partitionStoriesPlaylistByViewed,
  resolveStoriesPlaylist,
} from "./stories-playlist";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const story = (id: string, year = 2026): any => ({
  id,
  title: id,
  cat: "Drama",
  heroImage: `https://cdn/${id}.jpg`,
  year,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unpublished = (id: string, year = 2026): any => ({
  id,
  title: id,
  cat: "Drama",
  year,
});

const buildCatalog = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any => ({ array: rows, map: new Map() });

const emptyCuration = {
  hero: [],
  top10: [],
  continue: [],
  new_row: [],
  drama_row: [],
  entitled_row: [],
  humor_row: [],
  wholesome_row: [],
  dating_row: [],
  roommate_row: [],
};

describe("resolveStoriesPlaylist — augmenting + cap + filter-published", () => {
  it("returns [] when the catalog has no published stories", () => {
    const catalog = buildCatalog([unpublished("u1"), unpublished("u2")]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveStory = (id: string): any =>
      catalog.array.find((s: { id: string }) => s.id === id) ?? null;
    const result = resolveStoriesPlaylist(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      emptyCuration as any,
      catalog,
      resolveStory,
    );
    expect(result).toEqual([]);
  });

  it("returns published catalog stories sorted year DESC when curation is empty", () => {
    const catalog = buildCatalog([
      story("p_2024", 2024),
      story("p_2026", 2026),
      story("p_2025", 2025),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveStory = (id: string): any =>
      catalog.array.find((s: { id: string }) => s.id === id) ?? null;
    const result = resolveStoriesPlaylist(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      emptyCuration as any,
      catalog,
      resolveStory,
    );
    expect(result.map((s) => s.id)).toEqual(["p_2026", "p_2025", "p_2024"]);
  });

  it("drops unpublished entries (filter-before-cap parity with new_row)", () => {
    const catalog = buildCatalog([
      unpublished("u1", 2030),
      story("p1", 2024),
      story("p2", 2026),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveStory = (id: string): any =>
      catalog.array.find((s: { id: string }) => s.id === id) ?? null;
    const result = resolveStoriesPlaylist(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      emptyCuration as any,
      catalog,
      resolveStory,
    );
    expect(result.map((s) => s.id)).toEqual(["p2", "p1"]);
  });

  it("pins admin curation (new_row) at the front and fills with fallback", () => {
    const catalog = buildCatalog([
      story("p1", 2026),
      story("p2", 2025),
      story("p3", 2024),
      story("p4", 2023),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveStory = (id: string): any =>
      catalog.array.find((s: { id: string }) => s.id === id) ?? null;
    const curation = {
      ...emptyCuration,
      new_row: ["p3"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = resolveStoriesPlaylist(curation, catalog, resolveStory);
    expect(result.map((s) => s.id)).toEqual(["p3", "p1", "p2", "p4"]);
  });

  it("dedupes when curation overlaps fallback (no double-renders)", () => {
    const catalog = buildCatalog([
      story("p1", 2026),
      story("p2", 2025),
      story("p3", 2024),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveStory = (id: string): any =>
      catalog.array.find((s: { id: string }) => s.id === id) ?? null;
    const curation = {
      ...emptyCuration,
      new_row: ["p1", "p2"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = resolveStoriesPlaylist(curation, catalog, resolveStory);
    expect(result.map((s) => s.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("caps the playlist at STORIES_PLAYLIST_CAP (10)", () => {
    const rows = Array.from({ length: 30 }, (_, i) => story(`p${i}`, 2026 - i));
    const catalog = buildCatalog(rows);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveStory = (id: string): any =>
      catalog.array.find((s: { id: string }) => s.id === id) ?? null;
    const result = resolveStoriesPlaylist(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      emptyCuration as any,
      catalog,
      resolveStory,
    );
    expect(result).toHaveLength(STORIES_PLAYLIST_CAP);
    expect(result[0].id).toBe("p0");
    expect(result[9].id).toBe("p9");
  });

  it("drops curated ids that resolve to null (stale curation pointing at deleted story)", () => {
    const catalog = buildCatalog([story("p1", 2026), story("p2", 2025)]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveStory = (id: string): any =>
      catalog.array.find((s: { id: string }) => s.id === id) ?? null;
    const curation = {
      ...emptyCuration,
      new_row: ["does_not_exist", "p1"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = resolveStoriesPlaylist(curation, catalog, resolveStory);
    expect(result.map((s) => s.id)).toEqual(["p1", "p2"]);
  });

  it("drops curated ids that resolve to an unpublished story (placeholder safety)", () => {
    const catalog = buildCatalog([
      unpublished("draft"),
      story("p1", 2026),
      story("p2", 2025),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveStory = (id: string): any =>
      catalog.array.find((s: { id: string }) => s.id === id) ?? null;
    const curation = {
      ...emptyCuration,
      new_row: ["draft", "p2"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = resolveStoriesPlaylist(curation, catalog, resolveStory);
    expect(result.map((s) => s.id)).toEqual(["p2", "p1"]);
  });

  it("handles null curation (degrade to pure fallback)", () => {
    const catalog = buildCatalog([story("p1", 2026), story("p2", 2025)]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveStory = (id: string): any =>
      catalog.array.find((s: { id: string }) => s.id === id) ?? null;
    const result = resolveStoriesPlaylist(null, catalog, resolveStory);
    expect(result.map((s) => s.id)).toEqual(["p1", "p2"]);
  });
});

describe("filterStoriesPlaylistByUnseen", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const story = (id: string): any => ({ id });
  const playlist = [story("a"), story("b"), story("c"), story("d")];

  it("returns the full playlist when nothing is viewed", () => {
    expect(filterStoriesPlaylistByUnseen(playlist, []).map((s) => s.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("drops viewed ids while preserving order of the rest", () => {
    expect(
      filterStoriesPlaylistByUnseen(playlist, ["b", "d"]).map((s) => s.id),
    ).toEqual(["a", "c"]);
  });

  it("accepts a Set directly (avoids a redundant Array→Set rebuild on each render)", () => {
    expect(
      filterStoriesPlaylistByUnseen(playlist, new Set(["a", "c"])).map(
        (s) => s.id,
      ),
    ).toEqual(["b", "d"]);
  });

  it("returns [] when every story is viewed (signals 'hide rail')", () => {
    expect(
      filterStoriesPlaylistByUnseen(playlist, ["a", "b", "c", "d"]),
    ).toEqual([]);
  });
});

describe("partitionStoriesPlaylistByViewed — IG-style unseen-first ordering", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const story = (id: string): any => ({ id });
  const playlist = [story("a"), story("b"), story("c"), story("d")];

  it("returns the full playlist unchanged when nothing is viewed", () => {
    expect(
      partitionStoriesPlaylistByViewed(playlist, []).map((s) => s.id),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("moves viewed wires to the end while preserving within-group order", () => {
    // b + d are viewed → unseen group [a, c] leads, viewed group [b, d]
    // follows. Original order preserved within each group.
    expect(
      partitionStoriesPlaylistByViewed(playlist, ["b", "d"]).map((s) => s.id),
    ).toEqual(["a", "c", "b", "d"]);
  });

  it("when every wire is viewed, returns them all (now at the end of an empty unseen list)", () => {
    // Rail's job — not this helper's — to decide whether to render
    // anything in this case. The reorder semantics stay consistent:
    // empty unseen + full viewed = full viewed list.
    expect(
      partitionStoriesPlaylistByViewed(playlist, ["a", "b", "c", "d"]).map(
        (s) => s.id,
      ),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("accepts a Set directly (avoids redundant Array→Set rebuild)", () => {
    expect(
      partitionStoriesPlaylistByViewed(playlist, new Set(["c"])).map(
        (s) => s.id,
      ),
    ).toEqual(["a", "b", "d", "c"]);
  });
});
