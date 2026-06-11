// Tests for per-type article payload schemas and parseArticlePayload. These
// schemas live on the seam between the editor sidebar and the reader; getting
// the defaults and caps right means an empty payload renders without
// null-checks, and a hostile payload can't slip past validation.

import { describe, expect, it } from "vitest";
import {
  NewsPayloadSchema,
  FeaturePayloadSchema,
  ListiclePayloadSchema,
  ReviewPayloadSchema,
  parseArticlePayload,
  stringifyArticlePayload,
} from "@/lib/article-payload";

describe("NewsPayloadSchema", () => {
  it("defaults every field to empty string when given {}", () => {
    const out = NewsPayloadSchema.parse({});
    expect(out).toEqual({
      datelineLocation: "",
      datelineDate: "",
      sourceUrl: "",
      sourceLabel: "",
    });
  });

  it("trims whitespace on short text fields", () => {
    const out = NewsPayloadSchema.parse({
      datelineLocation: "   Tel Aviv  ",
    });
    expect(out.datelineLocation).toBe("Tel Aviv");
  });

  it("rejects a sourceUrl longer than 2000 chars", () => {
    // Constructed as a valid http URL so the only failing constraint is the
    // length cap — proves the cap fires independently of the URL refine.
    const longUrl = "https://example.com/" + "a".repeat(2100);
    expect(() => NewsPayloadSchema.parse({ sourceUrl: longUrl })).toThrow();
  });

  it("rejects a sourceUrl that is not http(s)", () => {
    expect(() =>
      NewsPayloadSchema.parse({ sourceUrl: "javascript:alert(1)" }),
    ).toThrow();
  });

  it("accepts an empty sourceUrl (the editor leaves it blank)", () => {
    const out = NewsPayloadSchema.parse({ sourceUrl: "" });
    expect(out.sourceUrl).toBe("");
  });
});

describe("FeaturePayloadSchema", () => {
  it("defaults reading time to 0 minutes", () => {
    expect(FeaturePayloadSchema.parse({})).toEqual({
      authorByline: "",
      readingTimeMinutes: 0,
    });
  });

  it("coerces string reading time into a number", () => {
    const out = FeaturePayloadSchema.parse({ readingTimeMinutes: "12" });
    expect(out.readingTimeMinutes).toBe(12);
  });

  it("falls back to 0 when the string is not numeric", () => {
    const out = FeaturePayloadSchema.parse({ readingTimeMinutes: "abc" });
    expect(out.readingTimeMinutes).toBe(0);
  });
});

describe("ListiclePayloadSchema", () => {
  it("defaults items to an empty array", () => {
    const out = ListiclePayloadSchema.parse({});
    expect(out.items).toEqual([]);
    expect(out.countdownOrder).toBe(false);
  });

  it("defaults each item's missing fields", () => {
    const out = ListiclePayloadSchema.parse({
      items: [{ title: "Top dog" }],
    });
    expect(out.items[0]).toEqual({
      rank: 1,
      title: "Top dog",
      body: "",
      imageUrl: "",
      imageAlt: "",
    });
  });

  it("rejects more than 50 items", () => {
    const items = Array.from({ length: 51 }, (_, i) => ({
      rank: i + 1,
      title: `t${i}`,
    }));
    expect(() => ListiclePayloadSchema.parse({ items })).toThrow();
  });

  it("rejects an item with a non-http imageUrl", () => {
    expect(() =>
      ListiclePayloadSchema.parse({
        items: [{ title: "x", imageUrl: "ftp://nope" }],
      }),
    ).toThrow();
  });
});

describe("ReviewPayloadSchema", () => {
  it("defaults rating to 0 and arrays to empty", () => {
    expect(ReviewPayloadSchema.parse({})).toEqual({
      rating: 0,
      verdict: "",
      pros: [],
      cons: [],
    });
  });

  it("clamps rating range via rejection above 10", () => {
    expect(() => ReviewPayloadSchema.parse({ rating: 11 })).toThrow();
  });

  it("coerces a string rating", () => {
    const out = ReviewPayloadSchema.parse({ rating: "7.5" });
    expect(out.rating).toBe(7.5);
  });

  it("rejects more than 20 pros or cons", () => {
    const big = Array.from({ length: 21 }, (_, i) => `p${i}`);
    expect(() => ReviewPayloadSchema.parse({ pros: big })).toThrow();
  });
});

describe("parseArticlePayload + stringifyArticlePayload", () => {
  it("returns defaulted payload for null/empty/garbage input", () => {
    const a = parseArticlePayload("news", null);
    const b = parseArticlePayload("news", "");
    const c = parseArticlePayload("news", "not json");
    expect(a.payload.datelineLocation).toBe("");
    expect(b.payload.datelineLocation).toBe("");
    expect(c.payload.datelineLocation).toBe("");
  });

  it("returns the right discriminated shape per type", () => {
    expect(parseArticlePayload("news", null).type).toBe("news");
    expect(parseArticlePayload("feature", null).type).toBe("feature");
    expect(parseArticlePayload("listicle", null).type).toBe("listicle");
    expect(parseArticlePayload("review", null).type).toBe("review");
  });

  it("round-trips through stringify -> parse and drops unknown fields", () => {
    const raw = JSON.stringify({
      datelineLocation: "London",
      garbage: "should be stripped",
      sourceUrl: "https://example.com",
    });
    const parsed = parseArticlePayload("news", raw);
    expect(parsed.payload).not.toHaveProperty("garbage");
    const serialized = stringifyArticlePayload(parsed);
    expect(serialized).not.toContain("garbage");
    const reparsed = parseArticlePayload("news", serialized);
    expect(reparsed.payload.datelineLocation).toBe("London");
  });
});
