// Coverage for the story JSON-LD builders
// (_plans/2026-07-05-seo-structured-data.md). The duration converter and
// the field-drop policy are the risky parts: a malformed duration or a
// null-valued property is worse for rich-result eligibility than absence.

import { describe, expect, it } from "vitest";

import { serializeJsonLd } from "@/lib/jsonld";
import {
  buildStoryJsonLd,
  durationToIso8601,
  type StoryJsonLdInput,
} from "@/lib/story-jsonld";

function story(overrides: Partial<StoryJsonLdInput> = {}): StoryJsonLdInput {
  return {
    title: "Text That Shifted Home",
    summary: "A roommate's decision upends communal living.",
    hero_image: "https://media.lorewire.com/x/hero.webp",
    thumbnail_image_landscape:
      "https://media.lorewire.com/x/thumbnail-landscape.webp",
    video_url: "https://media.lorewire.com/x-short/video.mp4",
    duration: "0:50",
    published_at: "2026-07-03T23:14:16Z",
    updated_at: "2026-07-04T10:00:00Z",
    ...overrides,
  };
}

const CTX = {
  canonicalUrl: "https://www.lorewire.com/v/text-that-shifted-home",
  siteName: "LoreWire",
};

describe("durationToIso8601", () => {
  it("converts the pipeline's M:SS format", () => {
    expect(durationToIso8601("0:50")).toBe("PT50S");
    expect(durationToIso8601("2:14")).toBe("PT2M14S");
    expect(durationToIso8601("12:03")).toBe("PT12M3S");
    expect(durationToIso8601("2:00")).toBe("PT2M");
  });

  it("accepts a defensive H:MM:SS", () => {
    expect(durationToIso8601("1:02:03")).toBe("PT1H2M3S");
  });

  it("returns undefined for null, empty, zero, and garbage", () => {
    expect(durationToIso8601(null)).toBeUndefined();
    expect(durationToIso8601("")).toBeUndefined();
    expect(durationToIso8601("0:00")).toBeUndefined();
    expect(durationToIso8601("90")).toBeUndefined();
    expect(durationToIso8601("2:75")).toBeUndefined();
    expect(durationToIso8601("a:bc")).toBeUndefined();
  });
});

describe("buildStoryJsonLd", () => {
  it("emits Article + VideoObject when a video exists", () => {
    const blocks = buildStoryJsonLd({ story: story(), ...CTX });
    expect(blocks.map((b) => b["@type"])).toEqual([
      "Article",
      "VideoObject",
    ]);
    const video = blocks[1];
    expect(video.contentUrl).toBe(
      "https://media.lorewire.com/x-short/video.mp4",
    );
    expect(video.duration).toBe("PT50S");
    expect(video.uploadDate).toBe("2026-07-03T23:14:16Z");
    expect(video.thumbnailUrl).toBe(
      "https://media.lorewire.com/x/thumbnail-landscape.webp",
    );
    expect(video.publisher).toEqual({
      "@type": "Organization",
      name: "LoreWire",
    });
  });

  it("emits only Article when there is no video", () => {
    const blocks = buildStoryJsonLd({
      story: story({ video_url: null }),
      ...CTX,
    });
    expect(blocks.map((b) => b["@type"])).toEqual(["Article"]);
    expect(blocks[0].headline).toBe("Text That Shifted Home");
    expect(blocks[0].datePublished).toBe("2026-07-03T23:14:16Z");
    expect(blocks[0].mainEntityOfPage).toBe(CTX.canonicalUrl);
  });

  it("falls back to the hero image when no landscape thumbnail exists", () => {
    const blocks = buildStoryJsonLd({
      story: story({ thumbnail_image_landscape: null }),
      ...CTX,
    });
    expect(blocks[0].image).toBe("https://media.lorewire.com/x/hero.webp");
  });

  it("drops missing fields instead of emitting nulls", () => {
    const blocks = buildStoryJsonLd({
      story: story({
        summary: null,
        duration: null,
        published_at: null,
        updated_at: null,
        thumbnail_image_landscape: null,
        hero_image: null,
      }),
      ...CTX,
    });
    for (const block of blocks) {
      expect(Object.values(block)).not.toContain(null);
      expect(block).not.toHaveProperty("description");
      expect(block).not.toHaveProperty("image");
      expect(block).not.toHaveProperty("datePublished");
    }
    expect(blocks[1]).not.toHaveProperty("duration");
  });
});

describe("serializeJsonLd", () => {
  it("unwraps a single block and keeps arrays for multiple", () => {
    expect(serializeJsonLd([{ a: 1 }])).toBe('{"a":1}');
    expect(serializeJsonLd([{ a: 1 }, { b: 2 }])).toBe('[{"a":1},{"b":2}]');
  });

  it("escapes < so content can never close the script tag", () => {
    const out = serializeJsonLd([{ t: "</script><script>alert(1)" }]);
    // No literal "<" survives, so "</script>" can't appear in the markup.
    expect(out).not.toContain("<");
    expect(out).toContain("\\u003c/script>");
    // Still valid JSON that parses back to the original string.
    expect(JSON.parse(out).t).toBe("</script><script>alert(1)");
  });
});
