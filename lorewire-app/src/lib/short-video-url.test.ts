// Tests for the short-video URL predicate that gates the public shorts feed
// (listPublishedShorts) and the live-media reader (getLiveStoryMedia). The
// suffix is the only signal distinguishing a short render from the long-form
// path, so a regression here silently lets long-form videos leak into the
// Reels feed (or hides real shorts) — pin it hard.

import { describe, expect, it } from "vitest";

import {
  SHORT_VIDEO_PATH,
  SHORT_VIDEO_PATH_RE,
  SHORT_VIDEO_URL_LIKE,
  isShortVideoUrl,
} from "./short-video-url";

describe("isShortVideoUrl", () => {
  it("accepts a plain short URL", () => {
    expect(
      isShortVideoUrl("https://storage.googleapis.com/bucket/abc123-short/video.mp4"),
    ).toBe(true);
  });

  it("accepts a short URL carrying a query string or fragment", () => {
    // Signed URLs and cache-busters append after the filename.
    expect(
      isShortVideoUrl(
        "https://storage.googleapis.com/bucket/abc-short/video.mp4?X-Goog-Signature=deadbeef",
      ),
    ).toBe(true);
    expect(isShortVideoUrl("https://cdn.example/abc-short/video.mp4#t=0")).toBe(true);
  });

  it("rejects the long-form video path", () => {
    expect(
      isShortVideoUrl("https://storage.googleapis.com/bucket/abc123/video.mp4"),
    ).toBe(false);
  });

  it("rejects a short frame image (not the video.mp4)", () => {
    // The short's doodle frames live at `<id>-short/frame-NN.png` — only the
    // rendered video.mp4 should count as the playable short.
    expect(
      isShortVideoUrl("https://storage.googleapis.com/bucket/abc-short/frame-03.png"),
    ).toBe(false);
  });

  it("rejects a URL where the suffix is not at the end", () => {
    // Defends against a stray match somewhere mid-path.
    expect(
      isShortVideoUrl("https://x/abc-short/video.mp4/extra/thing.mp4"),
    ).toBe(false);
  });

  it("rejects null, undefined, and empty", () => {
    expect(isShortVideoUrl(null)).toBe(false);
    expect(isShortVideoUrl(undefined)).toBe(false);
    expect(isShortVideoUrl("")).toBe(false);
  });
});

describe("SQL LIKE pattern parity", () => {
  it("wraps the same object-path substring the regex keys on", () => {
    // If the regex suffix ever changes, this forces the LIKE pattern (used by
    // the listPublishedShorts query) to change with it — they must agree or the
    // SQL pre-filter and the JS belt-and-braces filter would disagree.
    expect(SHORT_VIDEO_URL_LIKE).toBe(`%${SHORT_VIDEO_PATH}%`);
    expect(SHORT_VIDEO_PATH_RE.test(`anything${SHORT_VIDEO_PATH}`)).toBe(true);
  });
});
