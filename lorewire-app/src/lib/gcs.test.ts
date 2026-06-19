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

import { describe, expect, it } from "vitest";
import { parseGcsUrl } from "@/lib/gcs";

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
