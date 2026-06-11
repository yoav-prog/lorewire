// Tests for the SEO helpers. JSON-LD per article type, length-budget state
// transitions, and slug shape validation. JSON-LD shape is asserted on
// load-bearing fields (@type, headline, inLanguage, schema URL) rather than
// the full object so an additive field later doesn't churn the suite.

import { describe, expect, it } from "vitest";
import type { ArticleRow } from "@/lib/repo";
import {
  buildArticleJsonLd,
  isValidSlugShape,
  metaDescState,
  metaTitleState,
  META_DESC_OPTIMAL,
  META_TITLE_OPTIMAL,
} from "@/lib/article-seo";

function row(overrides: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: "art-1",
    type: "feature",
    language: "en",
    slug: "hello-world",
    title: "Hello world",
    subtitle: null,
    summary: "A summary",
    document: null,
    hero_image: null,
    status: "draft",
    author_id: null,
    meta_title: null,
    meta_description: null,
    og_image: null,
    payload: null,
    source_sheet_row_id: null,
    created_at: "2026-06-11T10:00:00.000Z",
    updated_at: "2026-06-11T10:00:00.000Z",
    published_at: null,
    ...overrides,
  };
}

describe("isValidSlugShape", () => {
  it("accepts lowercase, digits, single hyphens between segments", () => {
    expect(isValidSlugShape("hello")).toBe(true);
    expect(isValidSlugShape("hello-world")).toBe(true);
    expect(isValidSlugShape("a1-b2-c3")).toBe(true);
  });

  it("rejects empty, leading/trailing hyphen, double hyphen", () => {
    expect(isValidSlugShape("")).toBe(false);
    expect(isValidSlugShape("-hello")).toBe(false);
    expect(isValidSlugShape("hello-")).toBe(false);
    expect(isValidSlugShape("hello--world")).toBe(false);
  });

  it("rejects uppercase, whitespace, punctuation, unicode", () => {
    expect(isValidSlugShape("Hello")).toBe(false);
    expect(isValidSlugShape("hello world")).toBe(false);
    expect(isValidSlugShape("hello.world")).toBe(false);
    expect(isValidSlugShape("שלום")).toBe(false);
  });

  it("rejects slugs longer than 120 chars", () => {
    expect(isValidSlugShape("a".repeat(121))).toBe(false);
  });
});

describe("length-budget states", () => {
  it("metaTitleState transitions empty -> ok -> tight -> long", () => {
    expect(metaTitleState("")).toBe("empty");
    expect(metaTitleState("a".repeat(META_TITLE_OPTIMAL))).toBe("ok");
    expect(metaTitleState("a".repeat(META_TITLE_OPTIMAL + 1))).toBe("tight");
    expect(metaTitleState("a".repeat(200))).toBe("long");
  });

  it("metaDescState transitions empty -> ok -> tight -> long", () => {
    expect(metaDescState("")).toBe("empty");
    expect(metaDescState("a".repeat(META_DESC_OPTIMAL))).toBe("ok");
    expect(metaDescState("a".repeat(META_DESC_OPTIMAL + 1))).toBe("tight");
    expect(metaDescState("a".repeat(500))).toBe("long");
  });

  it("trims whitespace before counting (writer pastes with newlines)", () => {
    expect(metaTitleState("   ")).toBe("empty");
    expect(metaDescState("\n\t ")).toBe("empty");
  });
});

describe("buildArticleJsonLd / news", () => {
  it("emits NewsArticle with the right schema URL and core fields", () => {
    const ld = buildArticleJsonLd({
      article: row({
        type: "news",
        title: "Breaking",
        meta_description: "Short summary",
        language: "en",
        payload: JSON.stringify({
          datelineLocation: "Tel Aviv",
          datelineDate: "June 11",
          sourceUrl: "https://example.com",
          sourceLabel: "Example",
        }),
      }),
      siteOrigin: "https://lw.example",
    });
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("NewsArticle");
    expect(ld.headline).toBe("Breaking");
    expect(ld.inLanguage).toBe("en");
    expect(ld.dateline).toBe("Tel Aviv, June 11");
    expect(ld.mainEntityOfPage).toBe(
      "https://lw.example/articles/en/hello-world",
    );
    expect(ld.sourceOrganization).toMatchObject({
      "@type": "Organization",
      name: "Example",
      url: "https://example.com",
    });
  });

  it("drops sourceOrganization when label or URL is missing", () => {
    const ld = buildArticleJsonLd({
      article: row({
        type: "news",
        payload: JSON.stringify({
          datelineLocation: "",
          datelineDate: "",
          sourceUrl: "https://example.com",
          sourceLabel: "",
        }),
      }),
    });
    expect(ld.sourceOrganization).toBeUndefined();
  });
});

describe("buildArticleJsonLd / feature", () => {
  it("emits Article with author, timeRequired in PT?M, alternativeHeadline", () => {
    const ld = buildArticleJsonLd({
      article: row({
        type: "feature",
        title: "Long read",
        subtitle: "An essay",
        payload: JSON.stringify({
          authorByline: "Jane Doe",
          readingTimeMinutes: 8,
        }),
      }),
    });
    expect(ld["@type"]).toBe("Article");
    expect(ld.alternativeHeadline).toBe("An essay");
    expect(ld.author).toMatchObject({ "@type": "Person", name: "Jane Doe" });
    expect(ld.timeRequired).toBe("PT8M");
  });

  it("drops timeRequired when readingTime is 0", () => {
    const ld = buildArticleJsonLd({
      article: row({
        type: "feature",
        payload: JSON.stringify({
          authorByline: "",
          readingTimeMinutes: 0,
        }),
      }),
    });
    expect(ld.timeRequired).toBeUndefined();
    expect(ld.author).toBeUndefined();
  });
});

describe("buildArticleJsonLd / listicle", () => {
  it("emits ItemList with positions and itemListOrder", () => {
    const ld = buildArticleJsonLd({
      article: row({
        type: "listicle",
        payload: JSON.stringify({
          countdownOrder: true,
          items: [
            {
              rank: 1,
              title: "First",
              body: "Body",
              imageUrl: "",
              imageAlt: "",
            },
            {
              rank: 2,
              title: "Second",
              body: "",
              imageUrl: "https://cdn/2.png",
              imageAlt: "Alt",
            },
          ],
        }),
      }),
    });
    expect(ld["@type"]).toBe("ItemList");
    expect(ld.numberOfItems).toBe(2);
    expect(ld.itemListOrder).toBe(
      "https://schema.org/ItemListOrderDescending",
    );
    expect(Array.isArray(ld.itemListElement)).toBe(true);
    const items = ld.itemListElement as Array<Record<string, unknown>>;
    expect(items[0].position).toBe(1);
    expect(items[1].image).toBe("https://cdn/2.png");
  });
});

describe("buildArticleJsonLd / review", () => {
  it("emits Review with reviewRating 0..10 and itemReviewed Thing", () => {
    const ld = buildArticleJsonLd({
      article: row({
        type: "review",
        title: "Reviewed thing",
        payload: JSON.stringify({
          rating: 7.5,
          verdict: "Solid",
          pros: ["Fast"],
          cons: ["Loud"],
        }),
      }),
    });
    expect(ld["@type"]).toBe("Review");
    expect(ld.reviewRating).toMatchObject({
      "@type": "Rating",
      ratingValue: 7.5,
      bestRating: 10,
      worstRating: 0,
    });
    expect(ld.itemReviewed).toMatchObject({
      "@type": "Thing",
      name: "Reviewed thing",
    });
  });

  it("omits reviewRating when rating is 0", () => {
    const ld = buildArticleJsonLd({
      article: row({
        type: "review",
        payload: JSON.stringify({ rating: 0, verdict: "" }),
      }),
    });
    expect(ld.reviewRating).toBeUndefined();
  });
});

describe("buildArticleJsonLd / fallbacks", () => {
  it("defaults to Article when row has a missing/unknown type", () => {
    const ld = buildArticleJsonLd({
      article: row({ type: null as unknown as string }),
    });
    expect(ld["@type"]).toBe("Article");
  });

  it("uses meta_description over summary when both are set", () => {
    const ld = buildArticleJsonLd({
      article: row({
        type: "feature",
        summary: "summary fallback",
        meta_description: "meta wins",
      }),
    });
    expect(ld.description).toBe("meta wins");
  });

  it("falls back to summary when meta_description is empty", () => {
    const ld = buildArticleJsonLd({
      article: row({
        type: "feature",
        summary: "summary fallback",
        meta_description: null,
      }),
    });
    expect(ld.description).toBe("summary fallback");
  });
});
