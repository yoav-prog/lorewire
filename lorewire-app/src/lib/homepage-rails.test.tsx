// @vitest-environment happy-dom

// Tests for the live-catalog merging that drives the homepage rails AND
// the seeded path of the useHomepageCuration / useHomepagePolls hooks
// (added with _plans/2026-06-18-homepage-no-flash-ssr.md so the homepage
// Server Component can pre-fetch the data and skip the client round trip).
//
// Pure helpers tested: `liveRowToStory` (DB row -> Story shape),
// `mergeStaticAndLive` (live wins on id collision, live rows come first,
// no dupes), and `fallbackIdsForSurface` reading off the merged catalog
// (so newly published stories surface on the auto-derived rails without
// a re-export).
//
// Hook tests: the seeded path returns synchronously with loaded=true and
// never schedules a fetch. The legacy (unseeded) path is unchanged and
// covered live by the dev server today; we don't add a brittle integ
// test for it here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ALL_PILL,
  fallbackIdsForSurface,
  filterIdsByPillCat,
  filterIdsByPublished,
  liveRowToStory,
  mergeStaticAndLive,
  useHomepageCuration,
  useHomepagePolls,
} from "@/lib/homepage-rails";
import { STORIES, type Cat, type Story } from "@/lib/stories";
import * as actions from "@/app/actions";
import type {
  HomepageCuration,
  HomepageCurationBehavior,
  HomepagePollRailsResult,
  LiveCatalogStory,
} from "@/app/actions";

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

// Pill filter (_plans/2026-06-21-category-classifier-and-pills.md). The
// helper is what powers the home pill row: pure id-list filter against
// each id's resolved category.
describe("filterIdsByPillCat", () => {
  const stories: Record<string, Story> = {
    a: { ...STORIES[0], id: "a", cat: "Drama" as Cat },
    b: { ...STORIES[0], id: "b", cat: "Humor" as Cat },
    c: { ...STORIES[0], id: "c", cat: "Humor" as Cat },
    d: { ...STORIES[0], id: "d", cat: "Wholesome" as Cat },
  };
  const resolve = (id: string) => stories[id] ?? null;

  it("returns the list unchanged when pill is All", () => {
    const ids = ["a", "b", "c", "d"];
    expect(filterIdsByPillCat(ids, ALL_PILL, resolve)).toEqual(ids);
  });

  it("keeps only ids whose resolved story matches the active pill", () => {
    expect(filterIdsByPillCat(["a", "b", "c", "d"], "Humor", resolve)).toEqual([
      "b",
      "c",
    ]);
    expect(filterIdsByPillCat(["a", "b", "c", "d"], "Drama", resolve)).toEqual([
      "a",
    ]);
  });

  it("returns [] when nothing matches", () => {
    expect(
      filterIdsByPillCat(["a", "b", "c", "d"], "Dating", resolve),
    ).toEqual([]);
  });

  it("drops ids that don't resolve to a story", () => {
    const resolveWithGap = (id: string) =>
      id === "missing" ? null : stories[id] ?? null;
    expect(
      filterIdsByPillCat(["a", "missing", "b"], "Humor", resolveWithGap),
    ).toEqual(["b"]);
  });

  it("handles null / empty inputs", () => {
    expect(filterIdsByPillCat(null, "Humor", resolve)).toEqual([]);
    expect(filterIdsByPillCat(undefined, "Humor", resolve)).toEqual([]);
    expect(filterIdsByPillCat([], "Humor", resolve)).toEqual([]);
  });
});

// Published gate (matches Browse / Search / New & Hot). Home page rails
// run this after the pill filter so curated and fallback paths can't
// surface a sample placeholder card.
describe("filterIdsByPublished", () => {
  // Build placeholders explicitly — STORIES[0] in this codebase already
  // has the published.ts CMS overlay applied, so spreading from it would
  // smuggle in heroImage / videoUrl / body and turn every "placeholder"
  // into a published story.
  const bare = (id: string, overrides: Partial<Story> = {}): Story => ({
    id,
    title: id.toUpperCase(),
    cat: "Humor" as Cat,
    dur: "2:00",
    match: 90,
    year: 2026,
    glyph: "!",
    tags: ["True Story"],
    syn: "",
    ...overrides,
  });
  const stories: Record<string, Story> = {
    placeholder: bare("placeholder"),
    withVideo: bare("withVideo", { videoUrl: "https://cdn/v.mp4" }),
    withHero: bare("withHero", { heroImage: "https://cdn/h.png" }),
    withAudio: bare("withAudio", { audioUrl: "https://cdn/a.mp3" }),
    withBody: bare("withBody", { body: "real article" }),
    emptyBody: bare("emptyBody", { body: "" }),
  };
  const resolve = (id: string) => stories[id] ?? null;

  it("drops ids whose story has no produced content", () => {
    expect(
      filterIdsByPublished(
        ["placeholder", "withVideo", "withHero"],
        resolve,
      ),
    ).toEqual(["withVideo", "withHero"]);
  });

  it("keeps any of videoUrl / heroImage / audioUrl / body as published", () => {
    expect(
      filterIdsByPublished(
        ["withVideo", "withHero", "withAudio", "withBody"],
        resolve,
      ),
    ).toEqual(["withVideo", "withHero", "withAudio", "withBody"]);
  });

  it("treats empty-string body as a placeholder", () => {
    expect(filterIdsByPublished(["emptyBody"], resolve)).toEqual([]);
  });

  it("drops ids that don't resolve to a story", () => {
    expect(
      filterIdsByPublished(["withVideo", "missing"], resolve),
    ).toEqual(["withVideo"]);
  });

  it("handles null / empty inputs", () => {
    expect(filterIdsByPublished(null, resolve)).toEqual([]);
    expect(filterIdsByPublished(undefined, resolve)).toEqual([]);
    expect(filterIdsByPublished([], resolve)).toEqual([]);
  });
});

// Minimal hook host that mirrors components/ui/useDebouncedSave.test.tsx's
// approach: create a real React root, render a probe, capture the hook's
// return value into `current`. happy-dom (the test environment for this
// file) supplies the document the root needs.
function hostHook<T>(hook: () => T): { current: T; cleanup: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  const result = { current: undefined as unknown as T };
  function Probe() {
    result.current = hook();
    return null;
  }
  act(() => {
    root = createRoot(container);
    root.render(<Probe />);
  });
  return {
    get current() {
      return result.current;
    },
    cleanup() {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

const SEED_CURATION: HomepageCuration = {
  hero: ["seed-hero"],
  top10: ["seed-top-1", "seed-top-2"],
  continue: [],
  new_row: [],
  entitled_row: [],
  humor_row: [],
  wholesome_row: [],
  dating_row: [],
  roommate_row: [],
  drama_row: [],
};

const SEED_BEHAVIOR: HomepageCurationBehavior = {
  emptyRailBehavior: "fallback",
  heroRequired: false,
};

const SEED_LIVE_ROWS: LiveCatalogStory[] = [
  liveRow({ id: "seed-hero", title: "seed hero" }),
];

const SEED_POLLS: HomepagePollRailsResult = {
  ok: true,
  rails: { divisive: [], agreed: [], unpopular: [] },
  enabled: { divisive: true, agreed: true, unpopular: true },
};

describe("useHomepageCuration (seeded SSR path)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initialises synchronously from the seed and reports loaded=true on first render", () => {
    const spy = vi.spyOn(actions, "getHomepageCuration");
    const liveSpy = vi.spyOn(actions, "getLiveCatalog");
    const host = hostHook(() =>
      useHomepageCuration({
        curation: SEED_CURATION,
        behavior: SEED_BEHAVIOR,
        liveRows: SEED_LIVE_ROWS,
      }),
    );
    try {
      expect(host.current.loaded).toBe(true);
      expect(host.current.curation).toBe(SEED_CURATION);
      expect(host.current.behavior).toBe(SEED_BEHAVIOR);
      // The seed's live row must appear at the top of the merged catalog
      // — that's the load-bearing guarantee that the seeded hero / CW
      // rail render real content on the first paint, not the static
      // sample. `catalog.array[0]` is what `fallbackIdsForSurface("hero")`
      // returns when curation is empty.
      expect(host.current.catalog.array[0].id).toBe("seed-hero");
      // And no client fetch was scheduled.
      expect(spy).not.toHaveBeenCalled();
      expect(liveSpy).not.toHaveBeenCalled();
    } finally {
      host.cleanup();
    }
  });

  it("a null seed curation still keeps loaded=true (SSR succeeded but no curation rows yet)", () => {
    const host = hostHook(() =>
      useHomepageCuration({
        curation: null,
        behavior: SEED_BEHAVIOR,
        liveRows: SEED_LIVE_ROWS,
      }),
    );
    try {
      expect(host.current.loaded).toBe(true);
      expect(host.current.curation).toBeNull();
      // resolveStory still works for live ids.
      expect(host.current.resolveStory("seed-hero")?.title).toBe("SEED HERO");
    } finally {
      host.cleanup();
    }
  });
});

describe("useHomepagePolls (seeded SSR path)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initialises synchronously from the polls seed and skips the client fetch", () => {
    const spy = vi.spyOn(actions, "getHomepagePolls");
    const host = hostHook(() => useHomepagePolls(SEED_POLLS));
    try {
      expect(host.current.loaded).toBe(true);
      expect(host.current.rails).toBe(SEED_POLLS.rails);
      expect(host.current.enabled).toBe(SEED_POLLS.enabled);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      host.cleanup();
    }
  });
});

describe("fallbackIdsForSurface (merged catalog)", () => {
  // After 2026-06-24 fix: every fallback path filters by isPublishedStory
  // before slicing. Live rows must carry hero_image (or video_url) to
  // qualify — a row that exists in the DB but hasn't had artwork rendered
  // is not "published" by our definition and never appears in a rail.
  it("hero picks the first published entry of the merged catalog", () => {
    const merged = mergeStaticAndLive([
      liveRow({ id: "first", hero_image: "https://cdn.test/first.jpg" }),
    ]);
    expect(fallbackIdsForSurface("hero", merged.array)).toEqual(["first"]);
  });

  it("category rails pick published live rows", () => {
    const merged = mergeStaticAndLive([
      liveRow({
        id: "live-humor",
        category: "Humor",
        hero_image: "https://cdn.test/live-humor.jpg",
      }),
    ]);
    const ids = fallbackIdsForSurface("humor_row", merged.array);
    expect(ids).toContain("live-humor");
  });

  it("new_row sorts by year DESC so a 2026 live row outranks 2024 statics", () => {
    const merged = mergeStaticAndLive([
      liveRow({
        id: "fresh-2026",
        published_at: "2026-06-17T12:00:00Z",
        hero_image: "https://cdn.test/fresh-2026.jpg",
      }),
    ]);
    const ids = fallbackIdsForSurface("new_row", merged.array);
    expect(ids[0]).toBe("fresh-2026");
  });

  it("drops live rows without hero artwork (the 2026-06-24 regression case)", () => {
    // A live row with hero_image: null is in the DB but its artwork
    // hasn't rendered yet — it must NOT consume a rail slot, because
    // the rail layer would drop it later for being unpublished and the
    // user would see fewer items than the cap promised.
    const merged = mergeStaticAndLive([
      liveRow({ id: "no-art", category: "Drama", hero_image: null, video_url: null }),
    ]);
    const ids = fallbackIdsForSurface("drama_row", merged.array);
    expect(ids).not.toContain("no-art");
  });
});
