// Tests for the search predicate behind /admin/content. The predicate is a
// pure function of (row, query) so we exercise it without React.

import { describe, expect, it } from "vitest";
import {
  buildContentSearchHaystack,
  matchesContentSearch,
} from "@/lib/content-search";

const baseRow = {
  title: "THE STEAK STANDOFF",
  slug: "the-steak-standoff",
  badge: "Drama",
  status: "published",
  language: null,
  id: "abc12345-aaaa-bbbb-cccc-dddddddddddd",
};

describe("buildContentSearchHaystack", () => {
  it("joins all populated fields plus the id prefix, lowercased", () => {
    expect(buildContentSearchHaystack(baseRow)).toBe(
      "the steak standoff the-steak-standoff drama published abc12345",
    );
  });

  it("skips null fields without producing extra whitespace", () => {
    const h = buildContentSearchHaystack({
      title: null,
      slug: null,
      badge: null,
      status: null,
      language: null,
      id: "xyz98765-aaaa-bbbb-cccc-dddddddddddd",
    });
    expect(h).toBe("xyz98765");
  });
});

describe("matchesContentSearch", () => {
  it("matches every row for an empty or whitespace-only query", () => {
    expect(matchesContentSearch(baseRow, "")).toBe(true);
    expect(matchesContentSearch(baseRow, "   ")).toBe(true);
    expect(matchesContentSearch(baseRow, "\t\n")).toBe(true);
  });

  it("matches case-insensitively on title substrings", () => {
    expect(matchesContentSearch(baseRow, "steak")).toBe(true);
    expect(matchesContentSearch(baseRow, "STEAK")).toBe(true);
    expect(matchesContentSearch(baseRow, "Standoff")).toBe(true);
  });

  it("matches on slug, badge, and status", () => {
    expect(matchesContentSearch(baseRow, "the-steak")).toBe(true);
    expect(matchesContentSearch(baseRow, "drama")).toBe(true);
    expect(matchesContentSearch(baseRow, "published")).toBe(true);
  });

  it("matches on id prefix as displayed in the UI", () => {
    expect(matchesContentSearch(baseRow, "abc1")).toBe(true);
    expect(matchesContentSearch(baseRow, "abc12345")).toBe(true);
  });

  it("requires every whitespace-separated term to land (AND, not OR)", () => {
    expect(matchesContentSearch(baseRow, "steak drama")).toBe(true);
    expect(matchesContentSearch(baseRow, "steak entitled")).toBe(false);
    expect(matchesContentSearch(baseRow, "drama published")).toBe(true);
  });

  it("ignores leading and trailing whitespace in the query", () => {
    expect(matchesContentSearch(baseRow, "  steak  ")).toBe(true);
  });

  it("matches Hebrew title text without breaking on RTL", () => {
    const hebrewRow = {
      ...baseRow,
      title: "סטייק עומד מולי",
      slug: "steyk",
    };
    expect(matchesContentSearch(hebrewRow, "סטייק")).toBe(true);
    expect(matchesContentSearch(hebrewRow, "עומד")).toBe(true);
    expect(matchesContentSearch(hebrewRow, "סטייק עומד")).toBe(true);
    expect(matchesContentSearch(hebrewRow, "סטייק לא-קיים")).toBe(false);
  });

  it("survives a row whose title and slug are both null", () => {
    const row = {
      ...baseRow,
      title: null,
      slug: null,
    };
    expect(matchesContentSearch(row, "drama")).toBe(true);
    expect(matchesContentSearch(row, "abc1")).toBe(true);
    expect(matchesContentSearch(row, "missing")).toBe(false);
  });

  it("matches dollar signs and other punctuation as literal substrings", () => {
    const row = { ...baseRow, title: "The $800 Envelope" };
    expect(matchesContentSearch(row, "$800")).toBe(true);
    expect(matchesContentSearch(row, "envelope")).toBe(true);
  });
});
