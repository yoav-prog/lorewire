// Tests for the URL parsing/rewriting that drives the compression backfill.
// The DB + R2 + sharp halves are mocked; parseGcsUrl stays real so key
// extraction is exercised for real.

import { beforeEach, describe, expect, it, vi } from "vitest";

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
// sharp's re-encode is stubbed to a tiny fixed buffer; the batch tests assert
// control flow (work budget, cursor, DB repoint), not the bytes it produces.
vi.mock("sharp", () => {
  const chain = {
    rotate: () => chain,
    webp: () => chain,
    toBuffer: async () => Buffer.from("webp"),
  };
  return { default: () => chain };
});

import { all, run } from "@/lib/db";
import { getR2ObjectBytes, headR2Object, putR2Object } from "@/lib/r2";
import {
  compressBackfillBatch,
  imageUrlsIn,
  toWebpUrl,
  urlToKey,
} from "./compress-backfill";

beforeEach(() => vi.clearAllMocks());

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

describe("compressBackfillBatch", () => {
  it("compresses each image, repoints the DB, and finishes a short page", async () => {
    vi.mocked(all).mockResolvedValue([
      { id: "s1", hero_image: `${M}/s1/hero.png`, images: null, payload: null },
      { id: "s2", hero_image: `${M}/s2/hero.png`, images: null, payload: null },
    ]);
    vi.mocked(headR2Object).mockResolvedValue(null); // .webp twin absent -> encode
    vi.mocked(getR2ObjectBytes).mockResolvedValue(new ArrayBuffer(1000));
    vi.mocked(putR2Object).mockResolvedValue(undefined);
    vi.mocked(run).mockResolvedValue(undefined);

    const res = await compressBackfillBatch({
      table: "stories",
      dryRun: false,
      batchSize: 25,
    });

    expect(res.done).toBe(true);
    expect(res.nextCursor).toBeNull();
    expect(res.rows).toBe(2);
    expect(res.compressed).toBe(2);
    expect(res.failures).toEqual([]);
    expect(vi.mocked(run)).toHaveBeenCalledTimes(2); // one repoint per row
  });

  it("stops at a row boundary when the work budget is hit and returns a cursor", async () => {
    // 6 rows x 2 images = 2 encodes each; the live budget is 8, so it stops
    // after the 4th row with rows 5-6 of the page left for the next request.
    vi.mocked(all).mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({
        id: `s${i + 1}`,
        hero_image: `${M}/s${i + 1}/a.png`,
        images: JSON.stringify([`${M}/s${i + 1}/b.png`]),
        payload: null,
      })),
    );
    vi.mocked(headR2Object).mockResolvedValue(null);
    vi.mocked(getR2ObjectBytes).mockResolvedValue(new ArrayBuffer(500));
    vi.mocked(putR2Object).mockResolvedValue(undefined);
    vi.mocked(run).mockResolvedValue(undefined);

    const res = await compressBackfillBatch({
      table: "stories",
      dryRun: false,
      batchSize: 25,
    });

    expect(res.done).toBe(false);
    expect(res.nextCursor).toBe("s4");
    expect(res.compressed).toBe(8);
  });

  it("dry run counts what would compress without encoding or writing", async () => {
    vi.mocked(all).mockResolvedValue([
      { id: "s1", hero_image: `${M}/s1/hero.png`, images: null, payload: null },
    ]);
    vi.mocked(headR2Object).mockResolvedValue(null); // no webp twin yet -> would compress

    const res = await compressBackfillBatch({
      table: "stories",
      dryRun: true,
      batchSize: 25,
    });

    expect(res.compressed).toBe(1);
    expect(res.done).toBe(true);
    expect(vi.mocked(getR2ObjectBytes)).not.toHaveBeenCalled();
    expect(vi.mocked(putR2Object)).not.toHaveBeenCalled();
    expect(vi.mocked(run)).not.toHaveBeenCalled();
  });
});
