// Tests for the pure YouTube metadata layer: validation, the videos.insert
// body builder (clamping + tag normalization), the Shorts URL, and the
// story-to-payload mapper.

import { describe, expect, it } from "vitest";
import {
  YOUTUBE_LIMITS,
  buildVideosInsertBody,
  buildYoutubeShortUrl,
  mapStoryToYoutubePayload,
  validateYoutubePayload,
  type YoutubePublishPayload,
} from "./youtube-publish";

const base: YoutubePublishPayload = {
  title: "A clean title",
  description: "A short description.",
  tags: ["drama", "reddit"],
  categoryId: "22",
  privacyStatus: "private",
  madeForKids: false,
};

describe("validateYoutubePayload", () => {
  it("accepts a well-formed payload", () => {
    expect(validateYoutubePayload(base)).toEqual({ ok: true, errors: [] });
  });

  it("requires a title", () => {
    const r = validateYoutubePayload({ ...base, title: "   " });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/title is required/);
  });

  it("rejects an over-long title and description", () => {
    const r = validateYoutubePayload({
      ...base,
      title: "x".repeat(YOUTUBE_LIMITS.TITLE_MAX + 1),
      description: "y".repeat(YOUTUBE_LIMITS.DESCRIPTION_MAX + 1),
    });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBe(2);
  });

  it("rejects too many tags and an invalid privacy", () => {
    const r = validateYoutubePayload({
      ...base,
      tags: Array.from({ length: YOUTUBE_LIMITS.TAGS_COUNT_MAX + 1 }, (_, i) => `t${i}`),
      privacyStatus: "secret" as never,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/tags/);
    expect(r.errors.join(" ")).toMatch(/privacyStatus/);
  });
});

describe("buildVideosInsertBody", () => {
  it("produces the snippet + status shape", () => {
    const body = buildVideosInsertBody(base);
    expect(body.snippet.title).toBe("A clean title");
    expect(body.snippet.categoryId).toBe("22");
    expect(body.status.privacyStatus).toBe("private");
    expect(body.status.selfDeclaredMadeForKids).toBe(false);
  });

  it("clamps an oversized title and de-duplicates tags case-insensitively", () => {
    const body = buildVideosInsertBody({
      ...base,
      title: "z".repeat(YOUTUBE_LIMITS.TITLE_MAX + 50),
      tags: ["Drama", "drama", "DRAMA", "reddit"],
    });
    expect(body.snippet.title.length).toBe(YOUTUBE_LIMITS.TITLE_MAX);
    expect(body.snippet.tags).toEqual(["Drama", "reddit"]);
  });

  it("falls back to the default category when none is given", () => {
    const body = buildVideosInsertBody({ ...base, categoryId: "" });
    expect(body.snippet.categoryId).toBe("22");
  });
});

describe("buildYoutubeShortUrl", () => {
  it("builds the canonical shorts URL", () => {
    expect(buildYoutubeShortUrl("abc123")).toBe(
      "https://www.youtube.com/shorts/abc123",
    );
  });
});

describe("mapStoryToYoutubePayload", () => {
  it("derives defaults from the story and defaults to private", () => {
    const p = mapStoryToYoutubePayload({
      storyTitle: "  My   messy\n title ",
      storySummary: "The summary.",
      category: "Drama",
    });
    expect(p.title).toBe("My messy title"); // whitespace collapsed
    expect(p.description).toBe("The summary.");
    expect(p.tags).toEqual(["Drama"]);
    expect(p.privacyStatus).toBe("private");
    expect(p.madeForKids).toBe(false);
    expect(p.categoryId).toBe("22");
  });

  it("clamps a very long story title to the limit", () => {
    const p = mapStoryToYoutubePayload({ storyTitle: "t".repeat(200) });
    expect(p.title.length).toBe(YOUTUBE_LIMITS.TITLE_MAX);
  });

  it("falls back to a placeholder title and empty tags", () => {
    const p = mapStoryToYoutubePayload({ storyTitle: "" });
    expect(p.title).toBe("Untitled short");
    expect(p.tags).toEqual([]);
  });
});
