// Tests for the pure scoring + tokenising + snippet helpers behind the
// global admin search bar (plan:
// _plans/2026-06-19-global-admin-search.md). No React, no DB; the API
// route + the React island stand on this contract.

import { describe, expect, it } from "vitest";
import {
  MAX_QUERY_LENGTH,
  MAX_TOKENS,
  buildSnippet,
  compareScored,
  score,
  tokenise,
} from "@/lib/admin-search";

describe("tokenise", () => {
  it("splits on whitespace, lowercases, dedupes", () => {
    expect(tokenise("Steak Standoff steak")).toEqual(["steak", "standoff"]);
  });

  it("drops tokens shorter than 2 chars", () => {
    expect(tokenise("a I am ok")).toEqual(["am", "ok"]);
  });

  it("trims edge punctuation but keeps internal characters", () => {
    // "don't" survives intact; the trailing comma is dropped.
    expect(tokenise("don't, you?")).toEqual(["don't", "you"]);
  });

  it("strips leading r/ on subreddit-style tokens", () => {
    expect(tokenise("r/AITAH")).toEqual(["aitah"]);
  });

  it("caps tokens at MAX_TOKENS so SQL fan-out is bounded", () => {
    const many = Array.from({ length: 20 }, (_, i) => `tok${i}`).join(" ");
    expect(tokenise(many)).toHaveLength(MAX_TOKENS);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(tokenise("   ")).toEqual([]);
    expect(tokenise("")).toEqual([]);
  });

  it("exports a sensible MAX_QUERY_LENGTH", () => {
    // Spec says 100. Locked so a future tweak that lifts it past Postgres
    // parameter-binding limits at least breaks a test first.
    expect(MAX_QUERY_LENGTH).toBe(100);
  });
});

describe("score — phrase bonuses", () => {
  const tokens = tokenise("steak standoff");

  it("exact phrase in title is the strongest signal", () => {
    const { score: titlePhrase } = score(
      { title: "THE STEAK STANDOFF", summary: null, body: null, bucket: null },
      tokens,
      "steak standoff",
    );
    const { score: summaryPhrase } = score(
      {
        title: "Different Title",
        summary: "Once upon a time, the steak standoff began.",
        body: null,
        bucket: null,
      },
      tokens,
      "steak standoff",
    );
    expect(titlePhrase).toBeGreaterThan(summaryPhrase);
  });

  it("prefix bonus stacks on top of phrase-in-title", () => {
    const { score: prefix } = score(
      { title: "steak standoff aftermath", summary: null, body: null, bucket: null },
      tokens,
      "steak standoff",
    );
    const { score: middle } = score(
      { title: "the steak standoff aftermath", summary: null, body: null, bucket: null },
      tokens,
      "steak standoff",
    );
    expect(prefix).toBeGreaterThan(middle);
  });
});

describe("score — token bonuses + field weighting", () => {
  it("all-tokens-in-title beats any-token-in-title", () => {
    const { score: full } = score(
      { title: "leaf blower neighbor", summary: null, body: null, bucket: null },
      ["leaf", "blower"],
      "leaf blower",
    );
    const { score: partial } = score(
      { title: "leaf cleanup chronicles", summary: null, body: null, bucket: null },
      ["leaf", "blower"],
      "leaf blower",
    );
    expect(full).toBeGreaterThan(partial);
  });

  it("title hit weighted higher than summary hit weighted higher than body hit", () => {
    const tokens = ["leaf"];
    const titleHit = score(
      { title: "leaf", summary: null, body: null, bucket: null }, tokens, "leaf",
    ).score;
    const summaryHit = score(
      { title: null, summary: "leaf", body: null, bucket: null }, tokens, "leaf",
    ).score;
    const bodyHit = score(
      { title: null, summary: null, body: "leaf", bucket: null }, tokens, "leaf",
    ).score;
    expect(titleHit).toBeGreaterThan(summaryHit);
    expect(summaryHit).toBeGreaterThan(bodyHit);
  });

  it("bucket exact match earns +5", () => {
    const tokens = ["aitah"];
    const { score: bucketOnly } = score(
      { title: null, summary: null, body: null, bucket: "AITAH" }, tokens, "aitah",
    );
    const { score: nothing } = score(
      { title: null, summary: null, body: null, bucket: "Drama" }, tokens, "aitah",
    );
    expect(bucketOnly).toBe(5);
    expect(nothing).toBe(0);
  });

  it("score 0 returned when no field hits", () => {
    const result = score(
      { title: "different", summary: "different", body: "different", bucket: "drama" },
      ["leaf"], "leaf",
    );
    expect(result.score).toBe(0);
    expect(result.hits).toEqual({ title: false, summary: false, body: false, bucket: false });
  });

  it("empty tokens returns score 0 regardless of fields", () => {
    const result = score(
      { title: "leaf", summary: "leaf", body: "leaf", bucket: "drama" }, [], "",
    );
    expect(result.score).toBe(0);
  });

  it("hits flags reflect which fields actually contributed", () => {
    const result = score(
      { title: "leaf blower", summary: null, body: "background noise", bucket: null },
      ["leaf", "noise"],
      "leaf noise",
    );
    expect(result.hits.title).toBe(true);
    expect(result.hits.body).toBe(true);
    expect(result.hits.summary).toBe(false);
    expect(result.hits.bucket).toBe(false);
  });
});

describe("buildSnippet", () => {
  it("returns leading text when nothing matches", () => {
    const out = buildSnippet({ summary: "Hello world this is a long sentence." }, ["unrelated"]);
    expect(out).toContain("Hello world");
  });

  it("centres the window on the first matched token", () => {
    const long = "filler ".repeat(30) + "TARGET" + " filler".repeat(30);
    const out = buildSnippet({ body: long }, ["target"]);
    expect(out).toContain("**TARGET**");
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back across summary → body → full_text", () => {
    const out = buildSnippet(
      { summary: null, body: null, full_text: "The leaf blower started at dawn." },
      ["leaf"],
    );
    expect(out).toContain("**leaf**");
  });

  it("returns empty string when every source is empty/null", () => {
    expect(buildSnippet({ summary: null, body: null, full_text: null }, ["x"])).toBe("");
    expect(buildSnippet({ summary: "", body: "", full_text: "" }, ["x"])).toBe("");
  });

  it("wraps multiple matched tokens in the same window", () => {
    const out = buildSnippet({ body: "leaf and blower were both there" }, ["leaf", "blower"]);
    expect(out).toContain("**leaf**");
    expect(out).toContain("**blower**");
  });

  it("longest-token-first wrapping prevents inner double-wrapping", () => {
    // Both "leaf" and "leafblower" are tokens; the longer must wrap first
    // so we don't end up with **leaf**blower inside a leafblower match.
    const out = buildSnippet({ body: "the leafblower is loud" }, ["leaf", "leafblower"]);
    expect(out).toContain("**leafblower**");
    expect(out).not.toContain("**leaf**blower");
  });

  it("matching is case-insensitive on the snippet", () => {
    const out = buildSnippet({ body: "Leaf BLOWER chaos" }, ["leaf", "blower"]);
    expect(out).toContain("**Leaf**");
    expect(out).toContain("**BLOWER**");
  });

  it("regex metacharacters in tokens are escaped (no crash)", () => {
    // Tokens with regex special chars must not blow up the wrapper. The
    // ?, ., * etc. would otherwise be interpreted as regex syntax.
    expect(() => buildSnippet({ body: "what is this." }, ["this."])).not.toThrow();
  });
});

describe("compareScored", () => {
  it("higher score wins", () => {
    const sorted = [
      { score: 1, id: "a" },
      { score: 10, id: "b" },
    ].sort(compareScored);
    expect(sorted[0].id).toBe("b");
  });

  it("ties broken by updated_at DESC (newer first)", () => {
    const sorted = [
      { score: 5, updated_at: "2026-06-01", id: "a" },
      { score: 5, updated_at: "2026-06-10", id: "b" },
    ].sort(compareScored);
    expect(sorted[0].id).toBe("b");
  });

  it("further ties broken by id ASC for determinism", () => {
    const sorted = [
      { score: 5, updated_at: null, id: "b" },
      { score: 5, updated_at: null, id: "a" },
    ].sort(compareScored);
    expect(sorted[0].id).toBe("a");
  });
});
