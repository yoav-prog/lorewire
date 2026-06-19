// Tests for the magazine-layout image placer used by the homepage modal
// Read tab in both AppShell and DesktopShell.
//
// Regression context: AI-generated bodies sometimes arrive as a single
// paragraph blob with no `\n\n` separators. The previous inline
// `_articleImagePositions` bailed when paragraph count was below 3 and
// silently dropped every scene image. These tests pin the new behaviour:
// every scene is rendered (either inline between paragraphs or in the
// trailing extras strip), and the splitter falls back to single-newline
// then sentence chunking so a wall-of-text body still gives the
// distributor slots to work with.

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
    expect(r.extras).toEqual([]);
  });

  it("returns empty placement when there are no paragraphs", () => {
    const r = placeArticleImages(0, ["a.png"]);
    expect(r.inline.size).toBe(0);
    expect(r.extras).toEqual([]);
  });

  it("places the first scene after the opening paragraph for a 1-para body", () => {
    // Regression: previously bailed (paraCount < 3) and dropped every
    // image. Now we surface at least the first one inline and defer the
    // rest to extras so the reader sees illustrations either way.
    const r = placeArticleImages(1, ["a.png", "b.png", "c.png"]);
    expect(r.inline.get(0)).toBe("a.png");
    expect(r.extras).toEqual(["b.png", "c.png"]);
  });

  it("places the first scene after the opening paragraph for a 2-para body", () => {
    const r = placeArticleImages(2, ["a.png", "b.png", "c.png"]);
    expect(r.inline.get(0)).toBe("a.png");
    expect(r.extras).toEqual(["b.png", "c.png"]);
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
    expect(r.extras).toEqual([]);
  });

  it("never lands an image after the first or last paragraph", () => {
    // Keeps the magazine convention: image stays inside the body
    // between paragraphs, not above the opener or below the closer.
    const r = placeArticleImages(5, ["a.png", "b.png"]);
    for (const slot of r.inline.keys()) {
      expect(slot).toBeGreaterThanOrEqual(1);
      expect(slot).toBeLessThanOrEqual(4);
    }
  });

  it("pushes collisions to extras instead of overwriting the inline winner", () => {
    // A pathological case: 6 images across 4 paragraphs. The math
    // collapses several into the same slot — the loser MUST surface in
    // extras so it still renders as part of the trailing strip.
    const imgs = ["a.png", "b.png", "c.png", "d.png", "e.png", "f.png"];
    const r = placeArticleImages(4, imgs);
    const total = r.inline.size + r.extras.length;
    expect(total).toBe(imgs.length);
    for (const url of r.extras) expect(imgs).toContain(url);
  });

  it("preserves every input image across the inline + extras buckets", () => {
    // Belt-and-braces invariant the renderer relies on. No matter the
    // paragraph count, every scene is accounted for.
    for (const paraCount of [1, 2, 3, 5, 8, 10, 25]) {
      for (const imgCount of [0, 1, 2, 3, 5, 8]) {
        const imgs = Array.from({ length: imgCount }, (_, i) => `i${i}.png`);
        const r = placeArticleImages(paraCount, imgs);
        expect(r.inline.size + r.extras.length).toBe(imgCount);
        const seen = new Set<string>([...r.inline.values(), ...r.extras]);
        expect(seen.size).toBe(imgCount);
      }
    }
  });
});
