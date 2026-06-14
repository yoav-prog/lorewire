// Pins the per-word caption helpers used by both the editor preview's
// CaptionBand and (in mirror form) the renderer's DoodleCaption.
//
// Three contracts under test:
//   1. findActiveWordIndex — what the karaoke / highlight tracks at a
//      given elapsedMs, including the renderer's "stick to last word
//      after its end" behavior so the highlight doesn't blink off.
//   2. splitChunkWords — prefers alignment-derived words, falls back to
//      proportional split when missing or empty, returns [] for chunks
//      with no usable text.
//   3. Parity — the renderer's `video/src/caption-words.ts` and this
//      lorewire-app copy must hold the same bodies so editor preview
//      and rendered MP4 can't drift.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findActiveWordIndex,
  splitChunkWords,
} from "@/lib/caption-words";
import type { ShortCaptionChunk } from "@/lib/video-config";

function chunk(
  text: string,
  start_ms: number,
  end_ms: number,
  words?: ShortCaptionChunk["words"],
): ShortCaptionChunk {
  return { text, start_ms, end_ms, words };
}

describe("findActiveWordIndex", () => {
  const words = [
    { word: "a", start_ms: 0, end_ms: 500 },
    { word: "b", start_ms: 500, end_ms: 1000 },
    { word: "c", start_ms: 1200, end_ms: 1800 },
  ];

  it("returns the word whose [start, end) contains elapsedMs", () => {
    expect(findActiveWordIndex(words, 0)).toBe(0);
    expect(findActiveWordIndex(words, 250)).toBe(0);
    expect(findActiveWordIndex(words, 500)).toBe(1);
    expect(findActiveWordIndex(words, 999)).toBe(1);
    expect(findActiveWordIndex(words, 1500)).toBe(2);
  });

  it("returns -1 in a silent gap between words", () => {
    expect(findActiveWordIndex(words, 1100)).toBe(-1);
  });

  it("returns -1 before the first word", () => {
    expect(findActiveWordIndex(words, -50)).toBe(-1);
  });

  it("sticks to the last word after its end_ms (so the highlight does not blink off)", () => {
    expect(findActiveWordIndex(words, 1800)).toBe(2);
    expect(findActiveWordIndex(words, 5000)).toBe(2);
  });

  it("returns -1 for an empty words array", () => {
    expect(findActiveWordIndex([], 100)).toBe(-1);
  });
});

describe("splitChunkWords", () => {
  it("uses alignment-derived words when present", () => {
    const c = chunk("hello there", 0, 2000, [
      { word: "hello", start_ms: 100, end_ms: 900 },
      { word: "there", start_ms: 1000, end_ms: 1800 },
    ]);
    expect(splitChunkWords(c)).toEqual([
      { word: "hello", start_ms: 100, end_ms: 900 },
      { word: "there", start_ms: 1000, end_ms: 1800 },
    ]);
  });

  it("falls back to a proportional split when words are missing", () => {
    const c = chunk("hello there friend", 0, 3000);
    expect(splitChunkWords(c)).toEqual([
      { word: "hello", start_ms: 0, end_ms: 1000 },
      { word: "there", start_ms: 1000, end_ms: 2000 },
      { word: "friend", start_ms: 2000, end_ms: 3000 },
    ]);
  });

  it("falls back to proportional when words is present but empty", () => {
    const c = chunk("one two", 0, 1000, []);
    expect(splitChunkWords(c)).toEqual([
      { word: "one", start_ms: 0, end_ms: 500 },
      { word: "two", start_ms: 500, end_ms: 1000 },
    ]);
  });

  it("collapses runs of whitespace when tokenizing", () => {
    const c = chunk("  a   b  ", 0, 1000);
    expect(splitChunkWords(c).map((w) => w.word)).toEqual(["a", "b"]);
  });

  it("returns [] for chunks with no usable text", () => {
    expect(splitChunkWords(chunk("", 0, 1000))).toEqual([]);
    expect(splitChunkWords(chunk("   ", 0, 1000))).toEqual([]);
  });

  it("clamps a zero-or-negative span so the proportional split still produces ordered words", () => {
    const c = chunk("a b", 1000, 1000); // span = 0
    const out = splitChunkWords(c);
    expect(out).toHaveLength(2);
    expect(out[0]!.start_ms).toBeLessThanOrEqual(out[1]!.start_ms);
  });
});

// Parity guard. The renderer (Remotion project at video/src) keeps its
// own copy of these helpers because it can't reach across into the
// lorewire-app import graph. The function bodies + exported signatures
// MUST stay byte-identical so the editor preview and the rendered MP4
// can never disagree on which word is "active". Each file's leading
// file-header comment is allowed to differ (each one names the OTHER as
// the mirror), but everything from the first `import` onward must match
// after the import path is normalized.
describe("caption-words parity with video/src/caption-words.ts", () => {
  it("function bodies match the renderer's mirror file", () => {
    const localPath = path.resolve(__dirname, "caption-words.ts");
    const rendererPath = path.resolve(
      __dirname,
      "../../../video/src/caption-words.ts",
    );
    const local = fs.readFileSync(localPath, "utf8");
    const renderer = fs.readFileSync(rendererPath, "utf8");

    // Drop everything before the first `import` (each file's intro
    // comment) and the import lines themselves (the only structural
    // difference: import path). What's left is the function definitions
    // + their inline comments — that's the contract to pin.
    const stripPreamble = (src: string) => {
      const firstImport = src.indexOf("import ");
      const tail = firstImport >= 0 ? src.slice(firstImport) : src;
      return tail.replace(/^import[^;]*;\s*/gm, "").trim();
    };

    expect(stripPreamble(local)).toBe(stripPreamble(renderer));
  });
});
