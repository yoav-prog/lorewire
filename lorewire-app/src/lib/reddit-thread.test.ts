// Tests for the Reddit-thread identity helpers used by the article reader.
//
// The safety invariant: when an article asserts an authoritative Reddit
// thread id (via `story.id` for pipeline rows), the rendered embed URL
// MUST point at the same thread. A URL whose `/comments/<id>/` segment
// disagrees with the authoritative id is rejected so the reader never
// sees the wrong embedded thread under the article body — the bug this
// module was added to prevent.

import { describe, expect, it } from "vitest";
import {
  extractRedditId,
  isRealRedditId,
  isRealRedditUrl,
  resolveRedditEmbedTarget,
} from "./reddit-thread";

describe("isRealRedditId", () => {
  it("returns true for a well-formed base36 id", () => {
    expect(isRealRedditId("1lbd6ig")).toBe(true);
    expect(isRealRedditId("abc123")).toBe(true);
    expect(isRealRedditId("envelope")).toBe(true); // 8 alphanum, passes
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

  it("rejects ids containing non-alphanumeric chars", () => {
    expect(isRealRedditId("abc-123")).toBe(false);
    expect(isRealRedditId("abc 123")).toBe(false);
    expect(isRealRedditId("abc.123")).toBe(false);
  });

  it("rejects known placeholder strings", () => {
    expect(isRealRedditId("example")).toBe(false);
    expect(isRealRedditId("EXAMPLE")).toBe(false); // case-insensitive
    expect(isRealRedditId("test")).toBe(false);
    expect(isRealRedditId("placeholder")).toBe(false);
    expect(isRealRedditId("demo")).toBe(false);
    expect(isRealRedditId("sample")).toBe(false);
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
    expect(
      extractRedditId("https://reddit.com/r/aita/comments/abc123/"),
    ).toBe("abc123");
    expect(
      extractRedditId(
        "https://reddit.com/r/aita/comments/abc123/with_a_very_long_title_slug/",
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

describe("resolveRedditEmbedTarget", () => {
  const envelopeUrl =
    "https://www.reddit.com/r/AmItheAsshole/comments/1lbd6ig/aita_for_enforcing_basic_boundaries_on_my/";

  it("returns target with sourceUrl when authoritative id matches URL", () => {
    const url =
      "https://www.reddit.com/r/AmItheAsshole/comments/abc123/some_slug/";
    const r = resolveRedditEmbedTarget(url, "abc123");
    expect(r).not.toBeNull();
    expect(r!.url).toBe(url);
    expect(r!.redditId).toBe("abc123");
  });

  it("SUPPRESSES the embed when authoritative id and URL id mismatch (the envelope bug)", () => {
    // This is the safety invariant. story.id='envelope' AND a hand-attached
    // URL that points at the sleepover thread (id='1lbd6ig') MUST NOT render
    // an embed — otherwise the reader sees the wrong thread under the body.
    expect(resolveRedditEmbedTarget(envelopeUrl, "envelope")).toBeNull();
  });

  it("SUPPRESSES the embed when authoritative id is real but URL is missing", () => {
    // Refuses to synthesise a URL from a possibly-synthetic catalog id
    // (Reddit would 404 if the id isn't actually a real thread).
    expect(resolveRedditEmbedTarget(null, "envelope")).toBeNull();
    expect(resolveRedditEmbedTarget(undefined, "abc123")).toBeNull();
    expect(resolveRedditEmbedTarget("", "abc123")).toBeNull();
  });

  it("SUPPRESSES the embed when authoritative id is real but URL is unparseable", () => {
    expect(
      resolveRedditEmbedTarget("https://example.com/something", "abc123"),
    ).toBeNull();
  });

  it("falls back to URL-only check when authoritative id is missing", () => {
    // Legacy path: stories without a reliable authoritative id (e.g. the
    // sample catalog before redditId tracking) keep the older behavior —
    // any non-placeholder Reddit URL renders.
    const r = resolveRedditEmbedTarget(envelopeUrl, null);
    expect(r).not.toBeNull();
    expect(r!.url).toBe(envelopeUrl);
  });

  it("falls back to URL-only check when authoritative id is a 4-char sample", () => {
    // 'wifi' fails the 5+ alphanum bar, so we don't trust it as an
    // authoritative id and fall through to URL-only validation.
    const url =
      "https://www.reddit.com/r/funny/comments/abc123/something/";
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

  it("matches case-insensitively (URLs are lowercased before compare)", () => {
    const url =
      "https://www.reddit.com/r/AskReddit/comments/ABC123/title/";
    const r = resolveRedditEmbedTarget(url, "abc123");
    expect(r).not.toBeNull();
    expect(r!.redditId).toBe("abc123");
  });
});

describe("isRealRedditUrl", () => {
  it("delegates to resolveRedditEmbedTarget with no authoritative id", () => {
    // Back-compat shim — same as the old behavior.
    expect(
      isRealRedditUrl(
        "https://www.reddit.com/r/aita/comments/abc123/some_title/",
      ),
    ).toBe(true);
    expect(
      isRealRedditUrl(
        "https://www.reddit.com/r/aita/comments/example/",
      ),
    ).toBe(false);
    expect(isRealRedditUrl(null)).toBe(false);
  });
});
