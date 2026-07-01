// Tests for the magazine-layout image placer used by the homepage modal
// Read tab in both AppShell and DesktopShell.
//
// Context: scene images are only worth showing when they sit inside the
// read, flanked by prose. An article that ran out of body but still had
// scenes used to stack the leftovers below the last line, which reads as a
// dump. These tests pin the current behaviour: a scene only lands in a gap
// with a paragraph before AND after it, surplus scenes are dropped rather
// than trailed, and the splitter falls back to single-newline then
// sentence chunking so a wall-of-text body still gives the distributor
// slots to work with.

import { describe, expect, it } from "vitest";
import {
  placeArticleImages,
  splitArticleParagraphs,
} from "./article-image-positions";

describe("splitArticleParagraphs", () => {
  it("returns [] for an empty body so the caller can short-circuit", () => {
    expect(splitArticleParagraphs("")).toEqual([]);
    expect(splitArticleParagraphs(null)).toEqual([]);
    expect(splitArticleParagraphs(undefined)).toEqual([]);
  });

  it("splits on the canonical \\n\\n paragraph separator", () => {
    const body = "First.\n\nSecond.\n\nThird.";
    expect(splitArticleParagraphs(body)).toEqual([
      "First.",
      "Second.",
      "Third.",
    ]);
  });

  it("trims surrounding whitespace on each paragraph", () => {
    const body = "  First.  \n\n  Second.  ";
    expect(splitArticleParagraphs(body)).toEqual(["First.", "Second."]);
  });

  it("falls back to single-newline split when no \\n\\n is present", () => {
    // Some AI bodies use single newlines instead of doubled ones.
    const body = "First.\nSecond.\nThird.";
    expect(splitArticleParagraphs(body)).toEqual([
      "First.",
      "Second.",
      "Third.",
    ]);
  });

  it("chunks a single-blob body on sentence boundaries", () => {
    // The single-paragraph regression: pipeline ships the body with no
    // breaks at all. We chunk on sentence ends so the distributor still
    // has slots between sentences.
    const body =
      "First sentence. Second sentence. Third sentence. Fourth sentence.";
    const result = splitArticleParagraphs(body);
    expect(result.length).toBeGreaterThan(1);
    expect(result.join(" ")).toBe(body);
  });

  it("keeps a single-sentence body as one paragraph (no false chunking)", () => {
    expect(splitArticleParagraphs("Just one short line.")).toEqual([
      "Just one short line.",
    ]);
  });

  it("matches the envelope story body's 10 paragraphs", () => {
    // Pins parity with the published.ts envelope sample so a regression
    // that breaks the splitter for the canonical sample fails loudly.
    const envelope = [
      "P0 long opener.",
      "P1.",
      "P2.",
      "P3 longer middle paragraph here.",
      "P4 another middle.",
      "P5.",
      "P6 invoice surprise.",
      "P7 office mood shift.",
      "P8 what started as a favor.",
      "P9 the end of it.",
    ].join("\n\n");
    expect(splitArticleParagraphs(envelope)).toHaveLength(10);
  });
});

describe("placeArticleImages", () => {
  it("returns empty placement when there are no images", () => {
    const r = placeArticleImages(10, []);
    expect(r.inline.size).toBe(0);
  });

  it("returns empty placement when there are no paragraphs", () => {
    const r = placeArticleImages(0, ["a.png"]);
    expect(r.inline.size).toBe(0);
  });

  it("places nothing for a 1- or 2-paragraph body (no gap flanked by text)", () => {
    // Fewer than three paragraphs leaves no interior gap that has prose on
    // both sides, so we render text-only rather than trailing a stray
    // illustration below the last line.
    expect(placeArticleImages(1, ["a.png", "b.png"]).inline.size).toBe(0);
    expect(placeArticleImages(2, ["a.png", "b.png"]).inline.size).toBe(0);
  });

  it("distributes 3 scenes across 10 paragraphs at slots 2, 5, 7", () => {
    // Pins the canonical envelope shape: 10 paragraphs + 3 scenes →
    // image after paragraphs 2, 5, 7. Locks the existing distribution
    // so a future refactor can't quietly move them.
    const r = placeArticleImages(10, ["a.png", "b.png", "c.png"]);
    expect([...r.inline.keys()].sort((a, b) => a - b)).toEqual([2, 5, 7]);
    expect(r.inline.get(2)).toBe("a.png");
    expect(r.inline.get(5)).toBe("b.png");
    expect(r.inline.get(7)).toBe("c.png");
  });

  it("never lands an image after the first or last paragraph", () => {
    // The magazine convention: an image stays inside the body, with a
    // paragraph of lead-in before it and text after it — slots live in
    // [1, paraCount-2], never on the opener (0) or the closer (paraCount-1).
    for (const paraCount of [3, 5, 8, 10, 25]) {
      const imgs = Array.from({ length: 6 }, (_, i) => `i${i}.png`);
      const r = placeArticleImages(paraCount, imgs);
      for (const slot of r.inline.keys()) {
        expect(slot).toBeGreaterThanOrEqual(1);
        expect(slot).toBeLessThanOrEqual(paraCount - 2);
      }
    }
  });

  it("drops surplus scenes instead of trailing them below the body", () => {
    // 6 scenes against 4 paragraphs: only paragraph 1 and 2 have text on
    // both sides, so exactly two scenes render and the other four are
    // dropped — nothing stacks past the last paragraph.
    const imgs = ["a.png", "b.png", "c.png", "d.png", "e.png", "f.png"];
    const r = placeArticleImages(4, imgs);
    expect(r.inline.size).toBe(2);
    for (const url of r.inline.values()) expect(imgs).toContain(url);
  });

  it("places at most paraCount-2 scenes, each in a distinct gap with text after it", () => {
    // Invariant the renderer relies on: never more scenes than interior
    // gaps, every scene keyed to a distinct slot that has a following
    // paragraph so no illustration ever trails the text.
    for (const paraCount of [1, 2, 3, 5, 8, 10, 25]) {
      for (const imgCount of [0, 1, 2, 3, 5, 8]) {
        const imgs = Array.from({ length: imgCount }, (_, i) => `i${i}.png`);
        const r = placeArticleImages(paraCount, imgs);
        const capacity = Math.max(0, paraCount - 2);
        expect(r.inline.size).toBe(Math.min(imgCount, capacity));
        for (const slot of r.inline.keys()) {
          expect(slot + 1).toBeLessThanOrEqual(paraCount - 1);
        }
      }
    }
  });
});
