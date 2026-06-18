// Tests for the live-catalog merging that drives the homepage rails.
// The hook itself isn't tested here (React state + server actions) — these
// cover the pure helpers it composes: `liveRowToStory` (DB row ->
// Story shape), `mergeStaticAndLive` (live wins on id collision, live
// rows come first, no dupes), and `fallbackIdsForSurface` reading off
// the merged catalog (so newly published stories surface on the
// auto-derived rails without a re-export).

import { describe, expect, it } from "vitest";
import {
  fallbackIdsForSurface,
  liveRowToStory,
  mergeStaticAndLive,
} from "@/lib/homepage-rails";
import { STORIES } from "@/lib/stories";
import type { LiveCatalogStory } from "@/app/actions";

function liveRow(overrides: Partial<LiveCatalogStory> = {}): LiveCatalogStory {
  return {
    id: "live-1",
    slug: "live-1",
    title: "Live Story One",
    category: "Humor",
    summary: "live summary",
    duration: "1:30",
    hero_image: null,
    video_url: null,
    published_at: "2026-06-17T12:00:00Z",
    created_at: "2026-06-15T12:00:00Z",
    ...overrides,
  };
}

describe("liveRowToStory", () => {
  it("uppercases the title and forwards category as Cat", () => {
    const s = liveRowToStory(liveRow({ title: "hello world", category: "Humor" }));
    expect(s.title).toBe("HELLO WORLD");
    expect(s.cat).toBe("Humor");
  });

  it("falls back to id when title is null", () => {
    const s = liveRowToStory(liveRow({ id: "abc", title: null }));
    expect(s.title).toBe("ABC");
  });

  it("coerces unknown categories to Drama", () => {
    const s = liveRowToStory(liveRow({ category: "Politics" }));
    expect(s.cat).toBe("Drama");
  });

  it("parses year from published_at first, created_at second", () => {
    const a = liveRowToStory(liveRow({ published_at: "2025-01-01", created_at: "2020-01-01" }));
    expect(a.year).toBe(2025);
    const b = liveRowToStory(liveRow({ published_at: null, created_at: "2023-04-01" }));
    expect(b.year).toBe(2023);
  });

  it("carries hero_image and video_url when present", () => {
    const s = liveRowToStory(
      liveRow({ hero_image: "https://cdn/h.png", video_url: "https://cdn/v.mp4" }),
    );
    expect(s.heroImage).toBe("https://cdn/h.png");
    expect(s.videoUrl).toBe("https://cdn/v.mp4");
  });
});

describe("mergeStaticAndLive", () => {
  it("places live entries first and keeps every static story after", () => {
    const merged = mergeStaticAndLive([liveRow({ id: "fresh-1" })]);
    expect(merged.array[0].id).toBe("fresh-1");
    expect(merged.array.length).toBe(STORIES.length + 1);
    for (const s of STORIES) {
      expect(merged.byId.has(s.id)).toBe(true);
    }
  });

  it("lets a live row override a static story when ids collide", () => {
    const merged = mergeStaticAndLive([
      liveRow({ id: "envelope", title: "live envelope" }),
    ]);
    // Live wins in both the array order and the map.
    expect(merged.array[0].id).toBe("envelope");
    expect(merged.array[0].title).toBe("LIVE ENVELOPE");
    expect(merged.byId.get("envelope")?.title).toBe("LIVE ENVELOPE");
    // No duplicate envelope in the array.
    expect(merged.array.filter((s) => s.id === "envelope").length).toBe(1);
  });

  it("returns the static catalog untouched when no live rows arrive", () => {
    const merged = mergeStaticAndLive([]);
    expect(merged.array.length).toBe(STORIES.length);
    expect(merged.array[0].id).toBe(STORIES[0].id);
  });
});

describe("fallbackIdsForSurface (merged catalog)", () => {
  it("hero picks the first entry of the merged catalog", () => {
    const merged = mergeStaticAndLive([liveRow({ id: "first" })]);
    expect(fallbackIdsForSurface("hero", merged.array)).toEqual(["first"]);
  });

  it("category rails pick from the merged catalog, including live rows", () => {
    const merged = mergeStaticAndLive([liveRow({ id: "live-humor", category: "Humor" })]);
    const ids = fallbackIdsForSurface("humor_row", merged.array);
    expect(ids).toContain("live-humor");
  });

  it("new_row sorts by year DESC so a 2026 live row outranks 2024 statics", () => {
    const merged = mergeStaticAndLive([
      liveRow({ id: "fresh-2026", published_at: "2026-06-17T12:00:00Z" }),
    ]);
    const ids = fallbackIdsForSurface("new_row", merged.array);
    expect(ids[0]).toBe("fresh-2026");
  });
});
