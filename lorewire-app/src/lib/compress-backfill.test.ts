// Tests for the URL parsing/rewriting that drives the compression backfill.
// The DB + R2 + sharp halves are mocked; parseGcsUrl stays real so key
// extraction is exercised for real.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ all: vi.fn(), run: vi.fn() }));
vi.mock("@/lib/media-url", () => ({
  mediaPublicBase: () => "https://media.lorewire.com",
}));
vi.mock("@/lib/r2", () => ({
  MEDIA_CACHE_CONTROL: "cc",
  mediaBucket: () => "lorewire-media-prod",
  getR2ObjectBytes: vi.fn(),
  headR2Object: vi.fn(),
  putR2Object: vi.fn(),
  mediaUrlToKey: (url: string | null, base: string | null) => {
    if (!url || !base) return null;
    const b = base.replace(/\/+$/, "");
    if (!url.startsWith(`${b}/`)) return null;
    return url.slice(b.length + 1).split(/[?#]/)[0] || null;
  },
}));
vi.mock("@/lib/gcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gcs")>();
  return actual; // keep parseGcsUrl real
});

import { imageUrlsIn, toWebpUrl, urlToKey } from "./compress-backfill";

const G = "https://storage.googleapis.com/bucket";
const M = "https://media.lorewire.com";

describe("imageUrlsIn", () => {
  it("pulls png/jpg URLs out of a JSON blob, ignoring non-images", () => {
    const json = JSON.stringify({
      hero: `${G}/s1/hero.png`,
      scenes: [`${G}/s1/frame-01.png`, `${G}/s1/frame-02.jpg`],
      video: `${G}/s1/video.mp4`,
      audio: `${G}/s1/voice.mp3`,
      caption: "a png is a kind of image",
    });
    expect(imageUrlsIn(json).sort()).toEqual(
      [`${G}/s1/frame-01.png`, `${G}/s1/frame-02.jpg`, `${G}/s1/hero.png`].sort(),
    );
  });

  it("keeps a cache-bust query but stops at the boundary", () => {
    expect(imageUrlsIn(`"${G}/s1/hero.png?v=9"`)).toEqual([`${G}/s1/hero.png?v=9`]);
  });

  it("returns [] for null / no images", () => {
    expect(imageUrlsIn(null)).toEqual([]);
    expect(imageUrlsIn(`${G}/s1/video.mp4`)).toEqual([]);
  });
});

describe("toWebpUrl", () => {
  it("swaps the trailing image extension only, preserving query", () => {
    expect(toWebpUrl(`${G}/s1/hero.png`)).toBe(`${G}/s1/hero.webp`);
    expect(toWebpUrl(`${G}/s1/frame.jpeg`)).toBe(`${G}/s1/frame.webp`);
    expect(toWebpUrl(`${G}/s1/hero.png?v=9`)).toBe(`${G}/s1/hero.webp?v=9`);
    // a `.png` earlier in the path must not be touched
    expect(toWebpUrl(`${G}/png/hero.jpg`)).toBe(`${G}/png/hero.webp`);
  });
});

describe("urlToKey", () => {
  it("extracts the key from a GCS URL and a media URL", () => {
    expect(urlToKey(`${G}/s1/hero.png`)).toBe("s1/hero.png");
    expect(urlToKey(`${M}/s1/hero.png`)).toBe("s1/hero.png");
    expect(urlToKey(`${M}/s1/hero.png?v=9`)).toBe("s1/hero.png");
  });

  it("returns null for an unrelated host", () => {
    expect(urlToKey("https://example.com/x.png")).toBeNull();
  });
});
