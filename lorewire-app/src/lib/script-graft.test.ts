// Web port of `pipeline/captions.py::align_script_to_words`. These tests
// mirror `pipeline/tests/test_captions.py` so the two implementations stay
// in lockstep, plus a regression case for the Steak Standoff read-along
// homophones the user reported (state/stake/Temp/"they're telling").

import { describe, expect, it } from "vitest";
import { alignScriptToWords, tokenizeScript } from "@/lib/script-graft";

describe("tokenizeScript", () => {
  it("glues trailing punctuation to the word", () => {
    expect(tokenizeScript("Red, the barn was old.")).toEqual([
      "Red,",
      "the",
      "barn",
      "was",
      "old.",
    ]);
  });

  it("handles question marks and quotes", () => {
    expect(tokenizeScript('Was it? "Yes," she said.')).toEqual([
      "Was",
      "it?",
      '"Yes,"',
      "she",
      "said.",
    ]);
  });

  it("collapses internal whitespace", () => {
    expect(tokenizeScript("a  b\nc\t d")).toEqual(["a", "b", "c", "d"]);
  });

  it("returns empty for empty / whitespace-only", () => {
    expect(tokenizeScript("")).toEqual([]);
    expect(tokenizeScript("   ")).toEqual([]);
  });
});

describe("alignScriptToWords", () => {
  it("returns words unchanged when words is empty", () => {
    expect(alignScriptToWords("Red barn.", [])).toEqual([]);
  });

  it("returns words unchanged when script is empty", () => {
    const words = [{ word: "red", start: 0.0, end: 0.5 }];
    expect(alignScriptToWords("", words)).toEqual(words);
  });

  it("rewrites lowercased / unpunctuated STT to the script's form", () => {
    const words = [
      { word: "red", start: 0.0, end: 0.5 },
      { word: "the", start: 0.5, end: 0.8 },
      { word: "barn", start: 0.8, end: 1.2 },
    ];
    const out = alignScriptToWords("Red, the barn.", words);
    expect(out.map((w) => w.word)).toEqual(["Red,", "the", "barn."]);
    expect(out.map((w) => w.start)).toEqual([0.0, 0.5, 0.8]);
    expect(out.map((w) => w.end)).toEqual([0.5, 0.8, 1.2]);
  });

  it("corrects homophone substitutions", () => {
    const words = [
      { word: "read", start: 0.0, end: 0.5 }, // mishearing of "Red"
      { word: "the", start: 0.5, end: 0.8 },
      { word: "barn", start: 0.8, end: 1.2 },
    ];
    const out = alignScriptToWords("Red the barn", words);
    expect(out.map((w) => w.word)).toEqual(["Red", "the", "barn"]);
  });

  it("drops phantom STT words the script does not have", () => {
    const words = [
      { word: "red", start: 0.0, end: 0.5 },
      { word: "uh", start: 0.5, end: 0.6 }, // phantom
      { word: "the", start: 0.6, end: 0.9 },
      { word: "barn", start: 0.9, end: 1.3 },
    ];
    const out = alignScriptToWords("Red the barn", words);
    expect(out.map((w) => w.word)).toEqual(["Red", "the", "barn"]);
    expect(out.map((w) => w.start)).toEqual([0.0, 0.6, 0.9]);
  });

  it("wedges a zero-duration token when STT collapsed a word", () => {
    const words = [
      { word: "red", start: 0.0, end: 0.5 },
      // STT collapsed / dropped "the"
      { word: "barn", start: 0.5, end: 1.0 },
    ];
    const out = alignScriptToWords("Red the barn", words);
    expect(out.map((w) => w.word)).toEqual(["Red", "the", "barn"]);
    expect(out[1]).toEqual({ word: "the", start: 0.5, end: 0.5 });
  });

  it("is idempotent on script-authoritative input (ElevenLabs-shape)", () => {
    const words = [
      { word: "Red,", start: 0.0, end: 0.5 },
      { word: "the", start: 0.5, end: 0.8 },
      { word: "barn.", start: 0.8, end: 1.2 },
    ];
    const out = alignScriptToWords("Red, the barn.", words);
    expect(out).toEqual(words);
  });

  it("fixes the Steak Standoff regression (state/stake/Temp → steak/steak/temp)", () => {
    // STT output the user saw in production: "state", "stake", "Temp".
    // The script says "steak" twice and "temp" lowercase.
    const stt = [
      { word: "the", start: 0.0, end: 0.2 },
      { word: "state", start: 0.2, end: 0.6 }, // misheard "steak"
      { word: "came", start: 0.6, end: 0.9 },
      { word: "off", start: 0.9, end: 1.1 },
      { word: "made", start: 1.1, end: 1.4 },
      { word: "sure", start: 1.4, end: 1.7 },
      { word: "to", start: 1.7, end: 1.85 },
      { word: "Temp", start: 1.85, end: 2.2 }, // capitalised by STT
      { word: "it", start: 2.2, end: 2.4 },
      { word: "the", start: 2.4, end: 2.55 },
      { word: "stake", start: 2.55, end: 2.95 }, // misheard "steak"
    ];
    const script =
      "The steak came off made sure to temp it the steak";
    const out = alignScriptToWords(script, stt);
    expect(out.map((w) => w.word)).toEqual([
      "The",
      "steak",
      "came",
      "off",
      "made",
      "sure",
      "to",
      "temp",
      "it",
      "the",
      "steak",
    ]);
    // Timings come from the provider, not synthetic — the karaoke pulse
    // still tracks what the audio actually says.
    expect(out[1]).toMatchObject({ start: 0.2, end: 0.6 });
    expect(out[7]).toMatchObject({ start: 1.85, end: 2.2 });
  });
});
