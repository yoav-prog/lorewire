// Tests for the embed provider allowlist. The toEmbedUrl boundary is the
// security guarantee: anything that returns null never reaches an iframe
// src, so we exhaustively cover the supported URL shapes and the rejects.

import { describe, expect, it } from "vitest";
import { toEmbedUrl } from "@/lib/tiptap-embed";

describe("toEmbedUrl / YouTube", () => {
  it("accepts a standard watch URL", () => {
    expect(toEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
      provider: "youtube",
      embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    });
  });

  it("accepts a youtu.be short URL", () => {
    expect(toEmbedUrl("https://youtu.be/dQw4w9WgXcQ")).toEqual({
      provider: "youtube",
      embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    });
  });

  it("rejects a YouTube URL with a malformed video id", () => {
    expect(toEmbedUrl("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(toEmbedUrl("https://youtu.be/oops")).toBeNull();
  });

  it("strips extra query params (we only carry v= forward)", () => {
    const out = toEmbedUrl(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxxx",
    );
    expect(out?.embedUrl).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
  });
});

describe("toEmbedUrl / X (Twitter)", () => {
  it("accepts an x.com status URL", () => {
    expect(toEmbedUrl("https://x.com/jack/status/20")).toEqual({
      provider: "x",
      embedUrl: "https://platform.twitter.com/embed/Tweet.html?id=20",
    });
  });

  it("accepts the twitter.com legacy host", () => {
    expect(toEmbedUrl("https://twitter.com/jack/status/20")).toEqual({
      provider: "x",
      embedUrl: "https://platform.twitter.com/embed/Tweet.html?id=20",
    });
  });

  it("rejects a profile URL with no status path", () => {
    expect(toEmbedUrl("https://x.com/jack")).toBeNull();
  });
});

describe("toEmbedUrl / TikTok", () => {
  it("accepts a TikTok video URL", () => {
    expect(
      toEmbedUrl("https://www.tiktok.com/@user/video/7000000000000000000"),
    ).toEqual({
      provider: "tiktok",
      embedUrl: "https://www.tiktok.com/embed/v2/7000000000000000000",
    });
  });

  it("rejects a TikTok profile URL", () => {
    expect(toEmbedUrl("https://www.tiktok.com/@someuser")).toBeNull();
  });
});

describe("toEmbedUrl / rejects", () => {
  it("rejects empty / unparseable", () => {
    expect(toEmbedUrl("")).toBeNull();
    expect(toEmbedUrl("not a url")).toBeNull();
  });

  it("rejects non-http(s) schemes", () => {
    expect(toEmbedUrl("javascript:alert(1)")).toBeNull();
    expect(toEmbedUrl("data:text/html,<script>x</script>")).toBeNull();
    expect(toEmbedUrl("ftp://example.com/foo")).toBeNull();
  });

  it("rejects unsupported providers (Vimeo / Instagram / Bluesky)", () => {
    expect(toEmbedUrl("https://vimeo.com/12345")).toBeNull();
    expect(toEmbedUrl("https://www.instagram.com/p/Cabc/")).toBeNull();
    expect(toEmbedUrl("https://bsky.app/profile/x/post/y")).toBeNull();
  });
});
