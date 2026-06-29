// isPublishedStory gates the Browse / Search public listings: a story
// shows up only when the pipeline has produced real content for it
// (hero artwork, short render, narration audio, or article body). Mock
// placeholders in the static STORIES catalog ship with none of those
// fields and must be filtered out so the public surfaces don't promise
// stories the user can't actually consume.

import { describe, expect, it } from "vitest";

import { isPublishedStory, type Story } from "./stories";

function makeStory(overrides: Partial<Story> = {}): Story {
  return {
    id: "test",
    title: "TEST",
    cat: "Drama",
    dur: "2:00",
    match: 90,
    year: 2026,
    glyph: "/",
    tags: ["True Story"],
    syn: "",
    ...overrides,
  };
}

describe("isPublishedStory", () => {
  it("rejects a bare placeholder with no produced artefacts", () => {
    expect(isPublishedStory(makeStory())).toBe(false);
  });

  it("accepts a story with a rendered short (videoUrl)", () => {
    expect(
      isPublishedStory(makeStory({ videoUrl: "https://example/video.mp4" })),
    ).toBe(true);
  });

  it("accepts a story with hero artwork", () => {
    expect(
      isPublishedStory(makeStory({ heroImage: "https://example/hero.png" })),
    ).toBe(true);
  });

  it("accepts a story with narration audio", () => {
    expect(
      isPublishedStory(makeStory({ audioUrl: "https://example/narr.mp3" })),
    ).toBe(true);
  });

  it("accepts a story with an article body", () => {
    expect(isPublishedStory(makeStory({ body: "a real article" }))).toBe(true);
  });

  it("rejects a story whose body is an empty string", () => {
    expect(isPublishedStory(makeStory({ body: "" }))).toBe(false);
  });

  it("rejects a story whose media urls are empty strings", () => {
    expect(
      isPublishedStory(
        makeStory({ videoUrl: "", heroImage: "", audioUrl: "", body: "" }),
      ),
    ).toBe(false);
  });

  it("ignores tags / synopsis / glyph — those are present on every placeholder", () => {
    const placeholder = makeStory({
      tags: ["True Story", "Office"],
      syn: "a vivid synopsis",
      glyph: "$",
    });
    expect(isPublishedStory(placeholder)).toBe(false);
  });
});
