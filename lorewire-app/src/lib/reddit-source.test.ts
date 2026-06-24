// Tests for the TS CSV parser. The DB-write path (applyParsed, the bulk
// helpers, listRedditSources) is exercised end-to-end by the Python
// equivalents in pipeline/tests/test_reddit_db_sync.py — both paths
// share the same SQL shape and the same EXPECTED_HEADERS contract.

import { describe, expect, it } from "vitest";

import { parseCsvText, EXPECTED_HEADERS } from "./reddit-source";

const HEADERS = EXPECTED_HEADERS.join(",");

function csv(rows: string[][]): string {
  return [HEADERS, ...rows.map((r) => r.map(csvQuote).join(","))].join("\n");
}

function csvQuote(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

describe("parseCsvText", () => {
  it("parses a single happy-path row", () => {
    const text = csv([
      [
        "abc123",
        "AITAH",
        "2026-03-06 00:02",
        "test title",
        "body of the post",
        "42",
        "https://reddit.com/r/AITAH/abc123",
        "short summary",
        "16",
      ],
    ]);
    const { rows, warnings } = parseCsvText(text);
    expect(warnings).toEqual([]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.reddit_id).toBe("abc123");
    expect(r.subreddit).toBe("AITAH");
    expect(r.title).toBe("test title");
    expect(r.full_text).toBe("body of the post");
    expect(r.comments).toBe(42);
    expect(r.length_chars).toBe(16);
    expect(r.date_written).toBe("2026-03-06T00:02:00+00:00");
  });

  it("preserves embedded commas and quotes and newlines", () => {
    const text = csv([
      [
        "x1",
        "AITAH",
        "2026-01-01 00:00",
        'title with "quotes", commas',
        "line one\nline two\nline three",
        "5",
        "",
        "",
        "0",
      ],
    ]);
    const { rows, warnings } = parseCsvText(text);
    expect(warnings).toEqual([]);
    expect(rows[0].title).toBe('title with "quotes", commas');
    expect(rows[0].full_text).toBe("line one\nline two\nline three");
    // length_chars falls back to full_text length when "How Long it Is" is 0
    expect(rows[0].length_chars).toBe(rows[0].full_text.length);
  });

  it("warns on blank Reddit ID and skips the row", () => {
    const text = csv([
      [
        "",
        "AITAH",
        "2026-01-01 00:00",
        "t",
        "b",
        "1",
        "",
        "",
        "1",
      ],
      [
        "ok",
        "AITAH",
        "2026-01-01 00:00",
        "t",
        "b",
        "1",
        "",
        "",
        "1",
      ],
    ]);
    const { rows, warnings } = parseCsvText(text);
    expect(rows).toHaveLength(1);
    expect(rows[0].reddit_id).toBe("ok");
    expect(warnings.some((w) => w.includes("blank Reddit ID"))).toBe(true);
  });

  it("warns on duplicate Reddit IDs but keeps both rows", () => {
    const text = csv([
      ["dup", "AITAH", "2026-01-01 00:00", "first", "b1", "5", "", "", "2"],
      ["dup", "AITAH", "2026-01-02 00:00", "second", "b2", "10", "", "", "2"],
    ]);
    const { rows, warnings } = parseCsvText(text);
    expect(rows).toHaveLength(2);
    expect(warnings.some((w) => w.includes("duplicate Reddit ID"))).toBe(true);
  });

  it("throws on missing header column", () => {
    expect(() => parseCsvText("Reddit ID,Subreddit\nx,y\n")).toThrowError(
      /missing required header columns/,
    );
  });

  it("passes through an unparseable date with a warning", () => {
    const text = csv([
      [
        "x",
        "AITAH",
        "yesterday-ish",
        "t",
        "b",
        "1",
        "",
        "",
        "1",
      ],
    ]);
    const { rows, warnings } = parseCsvText(text);
    expect(rows[0].date_written).toBe("yesterday-ish");
    expect(
      warnings.some((w) => w.includes("not in YYYY-MM-DD HH:MM")),
    ).toBe(true);
  });

  it("strips a UTF-8 BOM if present", () => {
    const bom = "﻿";
    const text =
      bom +
      csv([
        [
          "x",
          "AITAH",
          "2026-01-01 00:00",
          "t",
          "b",
          "1",
          "",
          "",
          "1",
        ],
      ]);
    const { rows } = parseCsvText(text);
    expect(rows).toHaveLength(1);
    expect(rows[0].reddit_id).toBe("x");
  });

  it("strips thousands separators from numeric cells (Sheets exports '1,234')", () => {
    const text = csv([
      [
        "x",
        "AITAH",
        "2026-01-01 00:00",
        "t",
        "b",
        "1,234",
        "",
        "",
        "12,500",
      ],
    ]);
    const { rows, warnings } = parseCsvText(text);
    expect(warnings).toEqual([]);
    expect(rows[0].comments).toBe(1234);
    expect(rows[0].length_chars).toBe(12500);
  });

  it("rejects scientific notation in numeric cells (was silently coerced before)", () => {
    const text = csv([
      [
        "x",
        "AITAH",
        "2026-01-01 00:00",
        "t",
        "b",
        "1e3",
        "",
        "",
        "5",
      ],
    ]);
    const { rows } = parseCsvText(text);
    // "1e3" used to parse as 1000; we now reject it as not a clean integer.
    expect(rows[0].comments).toBeNull();
  });

  it("preserves the true first-seen line across 3+ duplicates of the same Reddit ID", () => {
    const text = csv([
      ["dup", "AITAH", "2026-01-01 00:00", "first", "b1", "5", "", "", "2"],
      ["dup", "AITAH", "2026-01-02 00:00", "second", "b2", "10", "", "", "2"],
      ["dup", "AITAH", "2026-01-03 00:00", "third", "b3", "20", "", "", "2"],
    ]);
    const { warnings } = parseCsvText(text);
    // Both warnings must point at the ORIGINAL first occurrence (line 2),
    // not at the immediately preceding duplicate. Previously the 3rd
    // occurrence said "first seen on line 3" because `seen.set(rid, lineNo)`
    // overwrote on every iteration.
    const firstSeenMentions = warnings.filter((w) =>
      w.includes("duplicate Reddit ID 'dup'"),
    );
    expect(firstSeenMentions).toHaveLength(2);
    for (const w of firstSeenMentions) {
      expect(w).toMatch(/first seen on line 2/);
    }
  });

  it("skips rows that lack required content (subreddit/title/full_text)", () => {
    const text = csv([
      ["a", "", "2026-01-01 00:00", "t", "b", "1", "", "", "1"],
      ["b", "AITAH", "2026-01-01 00:00", "", "b", "1", "", "", "1"],
      ["c", "AITAH", "2026-01-01 00:00", "t", "", "1", "", "", "1"],
      ["d", "AITAH", "2026-01-01 00:00", "t", "b", "1", "", "", "1"],
    ]);
    const { rows, warnings } = parseCsvText(text);
    expect(rows.map((r) => r.reddit_id)).toEqual(["d"]);
    expect(warnings).toHaveLength(3);
    expect(
      warnings.every((w) => w.includes("missing required field")),
    ).toBe(true);
  });
});

// 2026-06-24 Full Pipeline toggle DB writes. The toggle is the foundation
// the worker reads at finish-time, so a per-row + bulk write smoke test
// here protects the propagation chain end-to-end (column exists, default
// matches schema, setters write 0/1, list reflects the new value).
describe("Full Pipeline toggle setters", () => {
  // Lazy-import after vitest setup so the temp DB env vars are in place
  // before the db.ts module resolves a connection.

  async function seedSource(redditId: string) {
    const { run } = await import("@/lib/db");
    await run(
      "INSERT INTO reddit_source (reddit_id, subreddit, date_written, title, full_text, comments, status, first_synced, last_synced) " +
        "VALUES (?, 'AITAH', '2026-01-01T00:00:00+00:00', 't', 'f', 1, 'imported', '2026-06-24T00:00:00+00:00', '2026-06-24T00:00:00+00:00')",
      [redditId],
    );
  }

  async function clear() {
    const { run } = await import("@/lib/db");
    await run("DELETE FROM story_jobs", []);
    await run("DELETE FROM reddit_source", []);
  }

  it("setRedditSourceFullPipeline flips one row's column to 1 and back", async () => {
    await clear();
    await seedSource("a");
    const { setRedditSourceFullPipeline, getRedditSource } = await import(
      "./reddit-source"
    );

    await setRedditSourceFullPipeline("a", true);
    expect((await getRedditSource("a"))?.full_pipeline).toBe(1);

    await setRedditSourceFullPipeline("a", false);
    expect((await getRedditSource("a"))?.full_pipeline).toBe(0);
  });

  it("bulkSetRedditSourceFullPipeline flips many rows at once", async () => {
    await clear();
    await seedSource("a");
    await seedSource("b");
    await seedSource("c");
    const { bulkSetRedditSourceFullPipeline, getRedditSource } = await import(
      "./reddit-source"
    );

    const updated = await bulkSetRedditSourceFullPipeline(
      ["a", "b", "c"],
      true,
    );
    expect(updated).toBe(3);
    expect((await getRedditSource("a"))?.full_pipeline).toBe(1);
    expect((await getRedditSource("b"))?.full_pipeline).toBe(1);
    expect((await getRedditSource("c"))?.full_pipeline).toBe(1);

    // Flip only a subset back to 0.
    await bulkSetRedditSourceFullPipeline(["b"], false);
    expect((await getRedditSource("a"))?.full_pipeline).toBe(1);
    expect((await getRedditSource("b"))?.full_pipeline).toBe(0);
    expect((await getRedditSource("c"))?.full_pipeline).toBe(1);
  });

  it("bulkSetRedditSourceFullPipeline no-ops on an empty input", async () => {
    await clear();
    const { bulkSetRedditSourceFullPipeline } = await import(
      "./reddit-source"
    );
    expect(await bulkSetRedditSourceFullPipeline([], true)).toBe(0);
  });

  it("setRedditSourceFullPipeline rejects an empty reddit_id", async () => {
    const { setRedditSourceFullPipeline } = await import("./reddit-source");
    await expect(setRedditSourceFullPipeline("", true)).rejects.toThrow(
      /reddit_id/,
    );
  });
});
