// Tests for one migration batch. GCS + R2 are mocked so we pin the decision
// logic that actually moves production data: copy new, skip already-present
// (size match), flag too-large, verify size after upload, and isolate a single
// object's failure so the rest of the batch still proceeds.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/r2", () => ({
  MEDIA_CACHE_CONTROL: "public, max-age=31536000, immutable",
  mediaBucket: () => "lorewire-media-prod",
  headR2Object: vi.fn(),
  putR2Object: vi.fn(),
}));
vi.mock("@/lib/gcs", () => ({
  listObjects: vi.fn(),
  getObjectBytes: vi.fn(),
}));

import { getObjectBytes, listObjects } from "@/lib/gcs";
import { headR2Object, putR2Object } from "@/lib/r2";
import { MAX_OBJECT_BYTES, migrateBatch } from "./migrate-gcs-r2";

function obj(name: string, size: number) {
  return { name, size, contentType: "application/octet-stream", md5Hash: null };
}

beforeEach(() => {
  vi.clearAllMocks();
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

    // head: new.mp4 absent then 100 (post-upload verify); present.png matches;
    // boom.mp3 absent (then its download throws).
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
    expect(r.done).toBe(true);
    expect(r.nextCursor).toBeNull();
    // Present object was never downloaded or uploaded; too-large never headed.
    expect(getObjectBytes).toHaveBeenCalledTimes(2); // new + boom (boom throws)
    expect(putR2Object).toHaveBeenCalledTimes(1); // only new.mp4 actually uploads
    const failed = r.items.find((i) => i.status === "failed");
    expect(failed?.error).toContain("gcs 500");
  });
});
