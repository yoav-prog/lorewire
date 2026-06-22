// Parser-only tests for the GCS public-URL split. The upload + delete paths
// hit network, so they aren't tested here; this file locks down the parser
// shape — the only piece the content bulk delete depends on (per
// _plans/2026-06-19-content-bulk-actions.md, security section).
//
// `parseGcsUrl` must:
//   - accept `https://storage.googleapis.com/<bucket>/<key>` exactly,
//   - decode percent-encoded keys,
//   - keep nested keys (`a/b/c.mp4`) intact,
//   - reject any other host, malformed URL, or one-segment path.
//
// A null return is the contract callers rely on to "log and skip" — never
// throw — so any new ambiguity must come back as null, not an exception.
//
// It also covers the upload-time WebP compression helpers (swapKeyExtToWebp and
// maybeCompressImageBuffer), the Node mirror of pipeline/gcs.py: the pass-through
// for non-images, the .webp key swap, and the graceful fallback when bytes do
// not decode.

import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  maybeCompressImageBuffer,
  parseGcsUrl,
  swapKeyExtToWebp,
} from "@/lib/gcs";

describe("parseGcsUrl", () => {
  it("parses a plain bucket+key URL", () => {
    expect(parseGcsUrl("https://storage.googleapis.com/lw-media/foo.mp4")).toEqual({
      bucket: "lw-media",
      key: "foo.mp4",
    });
  });

  it("keeps nested keys intact", () => {
    expect(
      parseGcsUrl(
        "https://storage.googleapis.com/lw-media/stories/abc/short.mp4",
      ),
    ).toEqual({ bucket: "lw-media", key: "stories/abc/short.mp4" });
  });

  it("decodes percent-encoded segments in the key", () => {
    expect(
      parseGcsUrl(
        "https://storage.googleapis.com/lw-media/stories/abc%20def/short.mp4",
      ),
    ).toEqual({ bucket: "lw-media", key: "stories/abc def/short.mp4" });
  });

  it("strips query strings and fragments before parsing", () => {
    expect(
      parseGcsUrl(
        "https://storage.googleapis.com/lw-media/foo.mp4?cb=1#hash",
      ),
    ).toEqual({ bucket: "lw-media", key: "foo.mp4" });
  });

  it("rejects URLs whose host is not storage.googleapis.com", () => {
    expect(
      parseGcsUrl("https://media.lorewire.com/lw-media/foo.mp4"),
    ).toBeNull();
    expect(
      parseGcsUrl("https://cdn.example.com/lw-media/foo.mp4"),
    ).toBeNull();
  });

  it("rejects URLs with no key segment", () => {
    expect(parseGcsUrl("https://storage.googleapis.com/lw-media")).toBeNull();
    expect(parseGcsUrl("https://storage.googleapis.com/")).toBeNull();
  });

  it("rejects malformed URLs without throwing", () => {
    expect(parseGcsUrl("not a url")).toBeNull();
    expect(parseGcsUrl("")).toBeNull();
    expect(parseGcsUrl(null)).toBeNull();
    expect(parseGcsUrl(undefined)).toBeNull();
  });
});

describe("swapKeyExtToWebp", () => {
  it("swaps png / jpg / jpeg extensions to webp", () => {
    expect(swapKeyExtToWebp("hero.png")).toBe("hero.webp");
    expect(swapKeyExtToWebp("a/b/c.jpeg")).toBe("a/b/c.webp");
    expect(swapKeyExtToWebp("articles/x/img.JPG")).toBe("articles/x/img.webp");
  });

  it("appends .webp when the filename has no extension", () => {
    expect(swapKeyExtToWebp("articles/x/photo")).toBe("articles/x/photo.webp");
  });

  it("only rewrites the filename, never a directory dot", () => {
    expect(swapKeyExtToWebp("v1.2/c.png")).toBe("v1.2/c.webp");
  });
});

describe("maybeCompressImageBuffer", () => {
  it("passes non-compressible content types through untouched", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    expect(
      await maybeCompressImageBuffer(body, "x/y.webp", "image/webp"),
    ).toEqual({ body, key: "x/y.webp", contentType: "image/webp" });
    expect(
      await maybeCompressImageBuffer(body, "x/y.gif", "image/gif"),
    ).toEqual({ body, key: "x/y.gif", contentType: "image/gif" });
  });

  it("re-encodes a PNG upload to WebP and swaps the key to .webp", async () => {
    const png = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 200, g: 30, b: 60 },
      },
    })
      .png()
      .toBuffer();

    const out = await maybeCompressImageBuffer(
      png,
      "articles/abc/hero.png",
      "image/png",
    );

    expect(out.contentType).toBe("image/webp");
    expect(out.key).toBe("articles/abc/hero.webp");
    const meta = await sharp(out.body as Uint8Array).metadata();
    expect(meta.format).toBe("webp");
  });

  it("returns the original unchanged when the bytes are not a valid image", async () => {
    const garbage = new Uint8Array([0, 1, 2, 3, 4, 5]);
    expect(
      await maybeCompressImageBuffer(garbage, "articles/abc/broken.png", "image/png"),
    ).toEqual({
      body: garbage,
      key: "articles/abc/broken.png",
      contentType: "image/png",
    });
  });
});
