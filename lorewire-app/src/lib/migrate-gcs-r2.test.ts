// Tests for the migration batch logic and the "only LoreWire files" filter.
// GCS network calls (listObjects/getObjectBytes) and R2 are mocked, but the
// pure helpers (parseGcsUrl) stay real so the referenced-key extraction is
// exercised end to end. The DB layer is mocked to feed controlled rows.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ all: vi.fn() }));
vi.mock("@/lib/r2", () => ({
  MEDIA_CACHE_CONTROL: "public, max-age=31536000, immutable",
  mediaBucket: () => "lorewire-media-prod",
  headR2Object: vi.fn(),
  putR2Object: vi.fn(),
  // Test URLs are GCS URLs, so this R2-URL helper is a no-op here.
  mediaUrlToKey: () => null,
}));
vi.mock("@/lib/gcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gcs")>();
  return { ...actual, listObjects: vi.fn(), getObjectBytes: vi.fn() };
});

import { all } from "@/lib/db";
import { getObjectBytes, listObjects } from "@/lib/gcs";
import { headR2Object, putR2Object } from "@/lib/r2";
import {
  MAX_OBJECT_BYTES,
  buildReferencedKeys,
  migrateBatch,
} from "./migrate-gcs-r2";

function obj(name: string, size: number) {
  return { name, size, contentType: "application/octet-stream", md5Hash: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.__lwMigrateRefKeys = undefined; // reset referenced-key cache
});

describe("migrateBatch — dry run", () => {
  it("reports would-copy / too-large and never touches R2", async () => {
    vi.mocked(listObjects).mockResolvedValue({
      items: [obj("a/v.mp4", 100), obj("big.mp4", MAX_OBJECT_BYTES + 1)],
      nextPageToken: "PAGE2",
    });

    const r = await migrateBatch({ dryRun: true });

    expect(r.items.map((i) => i.status)).toEqual(["would-copy", "too-large"]);
    expect(r.nextCursor).toBe("PAGE2");
    expect(r.done).toBe(false);
    expect(headR2Object).not.toHaveBeenCalled();
    expect(putR2Object).not.toHaveBeenCalled();
    expect(getObjectBytes).not.toHaveBeenCalled();
  });
});

describe("migrateBatch — copy", () => {
  it("copies new, skips present, flags too-large, isolates a failure", async () => {
    vi.mocked(listObjects).mockResolvedValue({
      items: [
        obj("new.mp4", 100),
        obj("present.png", 50),
        obj("big.mp4", MAX_OBJECT_BYTES + 1),
        obj("boom.mp3", 30),
      ],
      nextPageToken: null,
    });

    const heads: Record<string, Array<number | null>> = {
      "new.mp4": [null, 100],
      "present.png": [50],
      "boom.mp3": [null],
    };
    vi.mocked(headR2Object).mockImplementation(async (_b: string, key: string) => {
      const q = heads[key];
      return q && q.length ? (q.shift() as number | null) : null;
    });
    vi.mocked(getObjectBytes).mockImplementation(async (key: string) => {
      if (key === "boom.mp3") throw new Error("gcs 500");
      return new ArrayBuffer(100);
    });
    vi.mocked(putR2Object).mockResolvedValue(undefined);

    const r = await migrateBatch({});

    expect(r.items.map((i) => i.status)).toEqual([
      "copied",
      "skipped-present",
      "too-large",
      "failed",
    ]);
    expect(getObjectBytes).toHaveBeenCalledTimes(2); // new + boom (boom throws)
    expect(putR2Object).toHaveBeenCalledTimes(1); // only new.mp4 uploads
    expect(r.items.find((i) => i.status === "failed")?.error).toContain("gcs 500");
  });
});

describe("migrateBatch — referenced-only filter", () => {
  it("skips objects not in the referenced set as orphans", async () => {
    vi.mocked(listObjects).mockResolvedValue({
      items: [obj("keep/video.mp4", 100), obj("orphan/old.png", 20)],
      nextPageToken: null,
    });
    const referenced = new Set(["keep/video.mp4"]);

    const r = await migrateBatch({ dryRun: true, referenced });

    expect(r.items.map((i) => i.status)).toEqual(["would-copy", "skipped-orphan"]);
  });
});

describe("buildReferencedKeys", () => {
  it("collects keys from stories, articles, segments, and short renders", async () => {
    const G = "https://storage.googleapis.com/bucket";
    vi.mocked(all)
      .mockResolvedValueOnce([
        {
          video_url: `${G}/s1/video.mp4`,
          audio_url: null,
          hero_image: `${G}/s1/hero.png`,
          images: JSON.stringify([`${G}/s1/frame-01.png`]),
          payload: JSON.stringify({ heroLandscape: `${G}/s1/hero-landscape.png` }),
        },
      ])
      .mockResolvedValueOnce([
        {
          hero_image: null,
          og_image: null,
          document: JSON.stringify({
            type: "doc",
            content: [{ type: "image", attrs: { src: `${G}/a1/pic.png` } }],
          }),
        },
      ])
      .mockResolvedValueOnce([
        { source_url: `${G}/segments/seg.source.mp4`, normalized_url: null },
      ])
      .mockResolvedValueOnce([
        { props: JSON.stringify({ doodle_frames: [{ url: `${G}/sh1/frame-0.png` }] }) },
      ]);

    const keys = await buildReferencedKeys();

    expect([...keys].sort()).toEqual(
      [
        "a1/pic.png",
        "s1/frame-01.png",
        "s1/hero-landscape.png",
        "s1/hero.png",
        "s1/video.mp4",
        "segments/seg.source.mp4",
        "sh1/frame-0.png",
      ].sort(),
    );
  });
});
