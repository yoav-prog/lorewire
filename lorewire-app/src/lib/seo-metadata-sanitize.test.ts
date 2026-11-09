import { describe, expect, it } from "vitest";
import { sanitizeSeoMetadata, type SeoMetadata } from "@/lib/seo-metadata";

function meta(overrides: Partial<SeoMetadata> = {}): SeoMetadata {
  return {
    youtube: {
      title: "The shelf war",
      description: "A fridge dispute. #Shorts #Reddit #TrueStory",
      tags: ["storytime", "reddit stories", "true stories", "roommates"],
    },
    tiktok: { caption: "wait for it #RedditStorytime #Shorts" },
    facebook: { caption: "A fridge dispute." },
    instagram: { caption: "A fridge dispute. #AITA #Shorts" },
    ...overrides,
  };
}

describe("sanitizeSeoMetadata", () => {
  it("strips source hashtags and keeps the rest", () => {
    const clean = sanitizeSeoMetadata(meta());
    expect(clean?.youtube.description).toBe("A fridge dispute. #Shorts");
    expect(clean?.tiktok.caption).toBe("wait for it #Shorts");
    expect(clean?.instagram.caption).toBe("A fridge dispute. #Shorts");
  });

  it("drops source tags", () => {
    expect(sanitizeSeoMetadata(meta())?.youtube.tags).toEqual(["storytime", "roommates"]);
  });

  it("falls back to the template when prose still names the source", () => {
    expect(
      sanitizeSeoMetadata(meta({ facebook: { caption: "This Reddit post went wild." } })),
    ).toBeNull();
  });

  it("falls back when every tag is removed", () => {
    expect(
      sanitizeSeoMetadata(
        meta({ youtube: { title: "T", description: "D", tags: ["reddit", "true story", "aita"] } }),
      ),
    ).toBeNull();
  });

  it("leaves clean metadata unchanged", () => {
    const clean: SeoMetadata = {
      youtube: { title: "T", description: "D #Shorts", tags: ["a", "b", "c"] },
      tiktok: { caption: "C" },
      facebook: { caption: "C" },
      instagram: { caption: "C" },
    };
    expect(sanitizeSeoMetadata(clean)).toEqual(clean);
  });

  it("does not trip on ordinary slashes", () => {
    const clean = meta({ facebook: { caption: "Her/him and or/and." } });
    expect(sanitizeSeoMetadata(clean)?.facebook.caption).toBe("Her/him and or/and.");
  });
});
