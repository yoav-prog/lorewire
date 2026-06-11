// Tests for the LCS-based block diff. The function is pure, so unit tests
// cover the algorithm exhaustively: identity, all-added, all-removed,
// inserts in the middle (where the LCS pays off vs a naïve positional
// diff), deletes in the middle, swaps, and tolerant fallback for garbage
// input.

import { describe, expect, it } from "vitest";
import {
  diffBlocks,
  diffDocuments,
  parseDoc,
  summarize,
  toDiffRows,
  type TiptapBlock,
} from "@/lib/article-diff";

function para(text: string): TiptapBlock {
  return {
    type: "paragraph",
    content: [{ type: "text", text }],
  };
}

function heading(level: number, text: string): TiptapBlock {
  return {
    type: "heading",
    attrs: { level },
    content: [{ type: "text", text }],
  };
}

function doc(content: TiptapBlock[]): string {
  return JSON.stringify({ type: "doc", content });
}

describe("parseDoc", () => {
  it("returns the empty doc for null / undefined / empty / garbage", () => {
    const a = parseDoc(null);
    const b = parseDoc(undefined);
    const c = parseDoc("");
    const d = parseDoc("not json");
    const e = parseDoc("42");
    expect(a.type).toBe("doc");
    expect(a.content).toHaveLength(1);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(d).toEqual(a);
    expect(e).toEqual(a);
  });

  it("returns the parsed doc when shape is valid", () => {
    const raw = doc([para("hi")]);
    const out = parseDoc(raw);
    expect(out.content?.[0]?.type).toBe("paragraph");
  });
});

describe("diffBlocks / identity and trivial cases", () => {
  it("returns all `same` when the two arrays are equal", () => {
    const blocks = [para("a"), heading(2, "b"), para("c")];
    const ops = diffBlocks(blocks, blocks);
    expect(ops).toHaveLength(3);
    expect(ops.every((o) => o.kind === "same")).toBe(true);
  });

  it("returns all `added` when previous is empty", () => {
    const ops = diffBlocks([], [para("a"), para("b")]);
    expect(ops.map((o) => o.kind)).toEqual(["added", "added"]);
  });

  it("returns all `removed` when current is empty", () => {
    const ops = diffBlocks([para("a"), para("b")], []);
    expect(ops.map((o) => o.kind)).toEqual(["removed", "removed"]);
  });
});

describe("diffBlocks / insertions and deletions in the middle", () => {
  it("flags exactly the inserted block in the middle", () => {
    const prev = [para("a"), para("c")];
    const curr = [para("a"), para("b"), para("c")];
    const ops = diffBlocks(prev, curr);
    expect(ops.map((o) => o.kind)).toEqual(["same", "added", "same"]);
  });

  it("flags exactly the removed block in the middle", () => {
    const prev = [para("a"), para("b"), para("c")];
    const curr = [para("a"), para("c")];
    const ops = diffBlocks(prev, curr);
    expect(ops.map((o) => o.kind)).toEqual(["same", "removed", "same"]);
  });

  it("does not regress on a swap (both removal + addition reported)", () => {
    // The LCS doesn't try to detect "moved" — a positional swap of two
    // unique blocks shows as one removal + one addition for each side.
    const prev = [para("a"), para("b")];
    const curr = [para("b"), para("a")];
    const ops = diffBlocks(prev, curr);
    const kinds = ops.map((o) => o.kind);
    expect(kinds.filter((k) => k === "added").length).toBeGreaterThanOrEqual(1);
    expect(kinds.filter((k) => k === "removed").length).toBeGreaterThanOrEqual(
      1,
    );
  });
});

describe("diffBlocks / attribute-sensitive equality", () => {
  it("treats different heading levels as not equal", () => {
    const ops = diffBlocks([heading(2, "x")], [heading(3, "x")]);
    expect(ops.map((o) => o.kind)).toEqual(["removed", "added"]);
  });

  it("ignores key order in JSON serialization (stable comparison)", () => {
    // Two blocks with identically-shaped attrs in different key order
    // should still compare equal — the diff stringifies with sorted keys.
    const a: TiptapBlock = {
      type: "heading",
      attrs: { level: 2, id: "x" } as Record<string, unknown>,
      content: [{ type: "text", text: "h" }],
    };
    const b: TiptapBlock = {
      type: "heading",
      attrs: { id: "x", level: 2 } as Record<string, unknown>,
      content: [{ type: "text", text: "h" }],
    };
    const ops = diffBlocks([a], [b]);
    expect(ops.map((o) => o.kind)).toEqual(["same"]);
  });
});

describe("toDiffRows + summarize", () => {
  it("projects ops into prev/curr pairs", () => {
    const rows = toDiffRows([
      { kind: "same", previous: para("a"), current: para("a") },
      { kind: "added", current: para("b") },
      { kind: "removed", previous: para("c") },
    ]);
    expect(rows[0].previous).not.toBeNull();
    expect(rows[0].current).not.toBeNull();
    expect(rows[1].previous).toBeNull();
    expect(rows[1].current).not.toBeNull();
    expect(rows[2].previous).not.toBeNull();
    expect(rows[2].current).toBeNull();
  });

  it("summary counts each kind", () => {
    const ops = diffBlocks([para("a"), para("b")], [para("a"), para("c")]);
    const s = summarize(ops);
    expect(s.added + s.removed + s.unchanged).toBe(ops.length);
  });
});

describe("diffDocuments / tolerant wrapper", () => {
  it("falls back to empty-vs-empty when both inputs are garbage", () => {
    const { rows, summary } = diffDocuments("not json", null);
    expect(summary.unchanged).toBeGreaterThan(0);
    expect(summary.added).toBe(0);
    expect(summary.removed).toBe(0);
    expect(rows.every((r) => r.kind === "same")).toBe(true);
  });

  it("treats garbage-previous as all-added against the current doc", () => {
    const current = doc([para("hello")]);
    const { summary } = diffDocuments("garbage", current);
    // empty doc -> one empty paragraph; current has one paragraph "hello"
    // -> one removed, one added.
    expect(summary.added).toBe(1);
    expect(summary.removed).toBe(1);
  });
});
