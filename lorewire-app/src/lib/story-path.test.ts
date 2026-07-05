// storyReaderPath is the single source of the card-link href — the
// crawlability fix (_plans/2026-07-05-seo-crawlability-and-metadata.md)
// hangs on it emitting /v/{slug} for published stories and null for the
// baked sample catalog, so StoryLink never renders a dead href.

import { describe, expect, it } from "vitest";

import { storyReaderPath } from "@/lib/story-path";

describe("storyReaderPath", () => {
  it("builds the public reader path from the slug", () => {
    expect(storyReaderPath({ slug: "text-that-shifted-home" })).toBe(
      "/v/text-that-shifted-home",
    );
  });

  it("returns null when the story has no slug (baked sample catalog)", () => {
    expect(storyReaderPath({ slug: undefined })).toBeNull();
  });

  it("returns null for an empty-string slug", () => {
    expect(storyReaderPath({ slug: "" })).toBeNull();
  });
});
