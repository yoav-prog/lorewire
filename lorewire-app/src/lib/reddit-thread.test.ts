// Tests for the Reddit-thread identity helpers used by the article reader.
//
// The safety invariants:
//  1. When an article asserts an authoritative Reddit thread id, the
//     rendered embed URL MUST point at the same thread — a URL whose
//     `/comments/<id>/` segment disagrees with the authoritative id is
//     rejected (the original envelope-bug case).
//  2. When the authoritative id is a STRONG signal (modern Reddit ids
//     contain at least one digit), the embed URL is CONSTRUCTED from
//     the id instead of trusting a stored `source_url`. Even if the
//     stored URL got dropped or mangled, the embed still resolves to
//     the right thread because Reddit canonicalises the short form.
//  3. Synthetic catalog ids (English words like 'envelope') without an
//     accompanying URL get NO embed — building `reddit.com/comments/envelope/`
//     would 404, and we never want to mislead the reader with a broken link.

import { describe, expect, it } from "vitest";
import {
  buildRedditEmbedUrl,
  extractRedditId,
  isRealRedditId,
  isRealRedditUrl,
  looksLikeRealRedditPostId,
  resolveRedditEmbedTarget,
} from "./reddit-thread";

describe("isRealRedditId (loose: alphanum 5+, no placeholders)", () => {
  it("accepts well-formed alphanumeric ids", () => {
    expect(isRealRedditId("1lbd6ig")).toBe(true);
    expect(isRealRedditId("abc123")).toBe(true);
    expect(isRealRedditId("envelope")).toBe(true); // 8 alphanum, loose check still true
  });

  it("rejects empty/missing values", () => {
    expect(isRealRedditId(null)).toBe(false);
    expect(isRealRedditId(undefined)).toBe(false);
    expect(isRealRedditId("")).toBe(false);
  });

  it("rejects ids shorter than 5 chars", () => {
    expect(isRealRedditId("wifi")).toBe(false);
    expect(isRealRedditId("a")).toBe(false);
  });

  it("rejects ids with non-alphanumeric chars", () => {
    expect(isRealRedditId("abc-123")).toBe(false);
    expect(isRealRedditId("abc 123")).toBe(false);
    expect(isRealRedditId("abc.123")).toBe(false);
  });

  it("rejects known placeholder strings (case-insensitive)", () => {
    expect(isRealRedditId("example")).toBe(false);
    expect(isRealRedditId("EXAMPLE")).toBe(false);
    expect(isRealRedditId("test")).toBe(false);
    expect(isRealRedditId("placeholder")).toBe(false);
    expect(isRealRedditId("demo")).toBe(false);
    expect(isRealRedditId("sample")).toBe(false);
  });
});

describe("looksLikeRealRedditPostId (strict: also requires a digit)", () => {
  it("accepts modern Reddit post ids that contain a digit", () => {
    expect(looksLikeRealRedditPostId("1lbd6ig")).toBe(true);
    expect(looksLikeRealRedditPostId("abc123")).toBe(true);
    expect(looksLikeRealRedditPostId("17xy3z9")).toBe(true);
  });

  it("rejects English-word catalog ids that lack digits", () => {
    // The key distinction: these would loose-pass `isRealRedditId` but
    // we refuse to construct a Reddit URL from them because Reddit would
    // 404 on `/comments/envelope/`.
    expect(looksLikeRealRedditPostId("envelope")).toBe(false);
    expect(looksLikeRealRedditPostId("fence")).toBe(false);
    expect(looksLikeRealRedditPostId("birthday")).toBe(false);
    expect(looksLikeRealRedditPostId("replyall")).toBe(false);
  });

  it("also rejects placeholders and too-short ids", () => {
    expect(looksLikeRealRedditPostId("example")).toBe(false);
    expect(looksLikeRealRedditPostId("wifi")).toBe(false);
    expect(looksLikeRealRedditPostId(null)).toBe(false);
  });
});

describe("extractRedditId", () => {
  it("pulls the id out of a canonical Reddit comments URL", () => {
    expect(
      extractRedditId(
        "https://www.reddit.com/r/AmItheAsshole/comments/1lbd6ig/aita_for_enforcing_basic_boundaries_on_my/",
      ),
    ).toBe("1lbd6ig");
  });

  it("lowercases the id", () => {
    expect(
      extractRedditId(
        "https://www.reddit.com/r/AskReddit/comments/ABC123/some_title/",
      ),
    ).toBe("abc123");
  });

  it("ignores the title slug after the id", () => {
    expect(extractRedditId("https://reddit.com/r/aita/comments/abc123/")).toBe(
      "abc123",
    );
    expect(
      extractRedditId(
        "https://reddit.com/r/aita/comments/abc123/with_a_long_title/",
      ),
    ).toBe("abc123");
  });

  it("returns null for URLs that aren't Reddit threads", () => {
    expect(extractRedditId("https://example.com/article")).toBe(null);
    expect(extractRedditId("https://reddit.com/r/aita")).toBe(null);
    expect(extractRedditId("not-a-url")).toBe(null);
  });

  it("returns null for empty/missing input", () => {
    expect(extractRedditId(null)).toBe(null);
    expect(extractRedditId(undefined)).toBe(null);
    expect(extractRedditId("")).toBe(null);
  });
});

describe("buildRedditEmbedUrl", () => {
  it("builds the canonical short form Reddit URL", () => {
    expect(buildRedditEmbedUrl("1lbd6ig")).toBe(
      "https://www.reddit.com/comments/1lbd6ig/",
    );
    expect(buildRedditEmbedUrl("abc123")).toBe(
      "https://www.reddit.com/comments/abc123/",
    );
  });

  it("lowercases the id before embedding it", () => {
    expect(buildRedditEmbedUrl("ABC123")).toBe(
      "https://www.reddit.com/comments/abc123/",
    );
  });
});

describe("resolveRedditEmbedTarget — strong authoritative id (modern Reddit)", () => {
  const goodUrl =
    "https://www.reddit.com/r/AmItheAsshole/comments/abc123/some_slug/";

  it("uses sourceUrl when URL parses to the SAME id (preserves title slug)", () => {
    const r = resolveRedditEmbedTarget(goodUrl, "abc123");
    expect(r).not.toBeNull();
    expect(r!.url).toBe(goodUrl);
    expect(r!.redditId).toBe("abc123");
  });

  it("CONSTRUCTS the URL when sourceUrl is missing", () => {
    // The new robustness win: even if source_url got dropped, the
    // embed still resolves correctly via constructed canonical URL.
    const r = resolveRedditEmbedTarget(null, "abc123");
    expect(r).not.toBeNull();
    expect(r!.url).toBe("https://www.reddit.com/comments/abc123/");
    expect(r!.redditId).toBe("abc123");
  });

  it("CONSTRUCTS the URL when sourceUrl is unparseable", () => {
    const r = resolveRedditEmbedTarget(
      "https://example.com/not-reddit",
      "abc123",
    );
    expect(r).not.toBeNull();
    expect(r!.url).toBe("https://www.reddit.com/comments/abc123/");
  });

  it("SUPPRESSES when sourceUrl points at a DIFFERENT thread (the envelope bug)", () => {
    // Strict id has digit but URL extract is a different id — safety
    // invariant says the data is contradicting itself, refuse to embed.
    const wrongUrl =
      "https://www.reddit.com/r/aita/comments/zzzzzz/different_thread/";
    expect(resolveRedditEmbedTarget(wrongUrl, "abc123")).toBeNull();
  });

  it("matches case-insensitively", () => {
    const upperUrl =
      "https://www.reddit.com/r/AskReddit/comments/ABC123/title/";
    const r = resolveRedditEmbedTarget(upperUrl, "abc123");
    expect(r).not.toBeNull();
    expect(r!.url).toBe(upperUrl);
  });
});

describe("resolveRedditEmbedTarget — loose authoritative id (synthetic catalog)", () => {
  // Ids like 'envelope' pass the loose check (alphanum 5+, no placeholder)
  // but fail the strict digit-required check. They get no constructed URL
  // because Reddit would 404 on `/comments/envelope/`.

  it("SUPPRESSES when sourceUrl is missing (refuses to construct from a synthetic id)", () => {
    expect(resolveRedditEmbedTarget(null, "envelope")).toBeNull();
    expect(resolveRedditEmbedTarget(undefined, "envelope")).toBeNull();
    expect(resolveRedditEmbedTarget("", "fence")).toBeNull();
  });

  it("SUPPRESSES when sourceUrl points at a different thread (envelope-bug case)", () => {
    // Exactly the bug from the user's screenshot: id='envelope',
    // sourceUrl='/comments/1lbd6ig/aita_for_enforcing_basic_boundaries/'.
    const sleepoverUrl =
      "https://www.reddit.com/r/AmItheAsshole/comments/1lbd6ig/aita_for_enforcing_basic_boundaries_on_my/";
    expect(resolveRedditEmbedTarget(sleepoverUrl, "envelope")).toBeNull();
  });

  it("uses sourceUrl when URL parses to the SAME id (matches the loose authoritative)", () => {
    // Edge case: someone hand-attached a real Reddit URL whose id
    // happens to equal the catalog id (unlikely but technically valid).
    const url =
      "https://www.reddit.com/r/aita/comments/envelope/some_thread/";
    const r = resolveRedditEmbedTarget(url, "envelope");
    expect(r).not.toBeNull();
    expect(r!.url).toBe(url);
  });
});

describe("resolveRedditEmbedTarget — no authoritative id (URL-only fallback)", () => {
  it("falls back to URL-only check when authoritative id is missing", () => {
    const url =
      "https://www.reddit.com/r/aita/comments/abc123/some_title/";
    const r = resolveRedditEmbedTarget(url, null);
    expect(r).not.toBeNull();
    expect(r!.url).toBe(url);
  });

  it("falls back to URL-only check when authoritative id is too short", () => {
    // 'wifi' (4 chars) fails the loose check too, so we fall through.
    const url = "https://www.reddit.com/r/funny/comments/abc123/x/";
    const r = resolveRedditEmbedTarget(url, "wifi");
    expect(r).not.toBeNull();
    expect(r!.redditId).toBe("abc123");
  });

  it("rejects placeholder URLs in the URL-only fallback", () => {
    expect(
      resolveRedditEmbedTarget(
        "https://www.reddit.com/r/aita/comments/example/",
        null,
      ),
    ).toBeNull();
  });

  it("returns null when neither side has a real id", () => {
    expect(resolveRedditEmbedTarget(null, null)).toBeNull();
    expect(resolveRedditEmbedTarget("not-a-url", undefined)).toBeNull();
    expect(resolveRedditEmbedTarget("", "")).toBeNull();
  });
});

describe("isRealRedditUrl (back-compat shim)", () => {
  it("delegates to resolveRedditEmbedTarget with no authoritative id", () => {
    expect(
      isRealRedditUrl(
        "https://www.reddit.com/r/aita/comments/abc123/some_title/",
      ),
    ).toBe(true);
    expect(
      isRealRedditUrl("https://www.reddit.com/r/aita/comments/example/"),
    ).toBe(false);
    expect(isRealRedditUrl(null)).toBe(false);
  });
});
