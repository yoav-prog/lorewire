// Tests for the Sheets helper's pure pieces. Network-touching functions
// (listTabs, readRows) are skipped — they belong to an integration test
// with a real fixture sheet, which is a Phase 4+ ask.

import { describe, expect, it } from "vitest";
import { parseSheetRef, stableRowId } from "@/lib/sheets";

describe("parseSheetRef", () => {
  it("extracts spreadsheetId from the canonical URL", () => {
    const ref = parseSheetRef(
      "https://docs.google.com/spreadsheets/d/1ABCDEFGHIJKLMNOPQRSTUVWXYZ_0/edit",
    );
    expect(ref).toEqual({
      spreadsheetId: "1ABCDEFGHIJKLMNOPQRSTUVWXYZ_0",
      gid: null,
    });
  });

  it("picks up gid from the hash form", () => {
    const ref = parseSheetRef(
      "https://docs.google.com/spreadsheets/d/1ABCDEFGHIJKLMNOPQRSTUVWXYZ_0/edit#gid=12345",
    );
    expect(ref?.gid).toBe(12345);
  });

  it("picks up gid from the search form", () => {
    const ref = parseSheetRef(
      "https://docs.google.com/spreadsheets/d/1ABCDEFGHIJKLMNOPQRSTUVWXYZ_0/edit?gid=98765",
    );
    expect(ref?.gid).toBe(98765);
  });

  it("accepts a bare spreadsheet id", () => {
    const ref = parseSheetRef("1ABCDEFGHIJKLMNOPQRSTUVWXYZ_0");
    expect(ref).toEqual({
      spreadsheetId: "1ABCDEFGHIJKLMNOPQRSTUVWXYZ_0",
      gid: null,
    });
  });

  it("returns null for clearly non-sheet inputs", () => {
    expect(parseSheetRef("")).toBeNull();
    expect(parseSheetRef("hello world")).toBeNull();
    expect(parseSheetRef("https://example.com/not-a-sheet")).toBeNull();
  });

  it("rejects an id shorter than 20 chars (paranoid sanity check)", () => {
    expect(parseSheetRef("short")).toBeNull();
  });
});

describe("stableRowId", () => {
  it("is deterministic for the same (spreadsheetId, rowKey)", () => {
    const a = stableRowId({ spreadsheetId: "abc", rowKey: "Hello" });
    const b = stableRowId({ spreadsheetId: "abc", rowKey: "Hello" });
    expect(a).toBe(b);
  });

  it("differs when the rowKey differs", () => {
    expect(
      stableRowId({ spreadsheetId: "abc", rowKey: "Hello" }),
    ).not.toBe(stableRowId({ spreadsheetId: "abc", rowKey: "World" }));
  });

  it("differs when the spreadsheetId differs (no cross-workbook collision)", () => {
    expect(
      stableRowId({ spreadsheetId: "abc", rowKey: "Hello" }),
    ).not.toBe(stableRowId({ spreadsheetId: "xyz", rowKey: "Hello" }));
  });

  it("returns a 24-char lowercase hex string", () => {
    const id = stableRowId({ spreadsheetId: "abc", rowKey: "Hello" });
    expect(id).toMatch(/^[a-f0-9]{24}$/);
  });
});
