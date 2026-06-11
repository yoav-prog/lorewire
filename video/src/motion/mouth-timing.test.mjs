// Unit tests for activeShape + pickOpen. Uses Node's built-in test runner
// (node:test, Node >= 18) so no devDependency is needed. Run via:
//   node --experimental-strip-types video/src/motion/mouth-timing.test.mjs
// or via the `test:motion` script in video/package.json.
//
// The TS source lives in mouth-timing.ts but Node can't import .ts directly
// without a loader. We mirror the constants and logic here in plain JS and
// keep them in sync by hand — the function is small (20 lines) and the rules
// are listed in mouth-timing.ts's docblock, which this file directly checks.

import { test } from "node:test";
import assert from "node:assert/strict";

const OPEN_CYCLE = ["ah", "ee", "oh"];
const PAUSE_MS = 200;
const OPEN_HOLD_MS = 90;

function pickOpen(localMs, anchorMs) {
  const idx =
    Math.floor(localMs / OPEN_HOLD_MS) + Math.floor(anchorMs / 1000);
  return OPEN_CYCLE[Math.abs(idx) % OPEN_CYCLE.length];
}

function activeShape(elapsedMs, words) {
  if (words.length === 0) return "closed";
  let currentWord = null;
  let prevWord = null;
  let nextWord = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (elapsedMs >= w.start_ms && elapsedMs < w.end_ms) {
      currentWord = w;
      break;
    }
    if (w.end_ms <= elapsedMs) prevWord = w;
    if (w.start_ms > elapsedMs && nextWord === null) nextWord = w;
  }
  if (currentWord) {
    return pickOpen(elapsedMs - currentWord.start_ms, currentWord.start_ms);
  }
  if (prevWord && nextWord) {
    const gap = nextWord.start_ms - prevWord.end_ms;
    if (gap < PAUSE_MS) {
      return pickOpen(elapsedMs - prevWord.end_ms, prevWord.end_ms);
    }
  }
  return "closed";
}

const words = [
  { word: "hello", start_ms: 1000, end_ms: 1400 },
  { word: "world", start_ms: 1500, end_ms: 1900 }, // 100ms gap (open)
  { word: "after", start_ms: 2300, end_ms: 2700 }, // 400ms pause (closed)
  { word: "pause", start_ms: 2750, end_ms: 3150 }, // 50ms gap (open)
];

test("empty alignment -> closed", () => {
  assert.equal(activeShape(0, []), "closed");
  assert.equal(activeShape(1000, []), "closed");
});

test("before first word -> closed", () => {
  assert.equal(activeShape(0, words), "closed");
  assert.equal(activeShape(999, words), "closed");
});

test("inside a word -> open", () => {
  assert.notEqual(activeShape(1000, words), "closed");
  assert.notEqual(activeShape(1200, words), "closed");
  assert.notEqual(activeShape(1399, words), "closed");
});

test("exact end_ms is exclusive -> falls through to gap logic", () => {
  // end_ms is exclusive on the word; the 100ms gap that follows is short, so
  // we expect open via the short-gap rule.
  assert.notEqual(activeShape(1400, words), "closed");
});

test("short gap (< 200ms) -> open", () => {
  assert.notEqual(activeShape(1450, words), "closed");
  assert.notEqual(activeShape(2720, words), "closed"); // 20ms into a 50ms gap
});

test("long pause (>= 200ms) -> closed", () => {
  assert.equal(activeShape(2000, words), "closed"); // 100ms into 400ms pause
  assert.equal(activeShape(2150, words), "closed"); // mid pause
  assert.equal(activeShape(2299, words), "closed"); // 1ms before next word
});

test("after last word with no next -> closed", () => {
  assert.equal(activeShape(3151, words), "closed");
  assert.equal(activeShape(4000, words), "closed");
  assert.equal(activeShape(10_000, words), "closed");
});

test("word at t=0 (no leading silence) -> open", () => {
  const startWords = [{ word: "go", start_ms: 0, end_ms: 200 }];
  assert.notEqual(activeShape(0, startWords), "closed");
});

test("negative elapsedMs (defensive) -> closed", () => {
  assert.equal(activeShape(-100, words), "closed");
  assert.equal(activeShape(-1, words), "closed");
});

test("cycling: shapes differ at OPEN_HOLD_MS intervals", () => {
  const s0 = activeShape(1000, words);
  const s1 = activeShape(1090, words);
  const s2 = activeShape(1180, words);
  assert.notEqual(s0, s1);
  assert.notEqual(s1, s2);
  // Full cycle wraps after 3 * OPEN_HOLD_MS = 270 ms.
  assert.equal(activeShape(1270, words), s0);
});

test("stable within a single OPEN_HOLD_MS window", () => {
  assert.equal(activeShape(1000, words), activeShape(1050, words));
  assert.equal(activeShape(1090, words), activeShape(1130, words));
});

test("cycle is deterministic across renders (same input -> same output)", () => {
  for (let t = 0; t < 4000; t += 16) {
    assert.equal(activeShape(t, words), activeShape(t, words));
  }
});

test("PAUSE_MS boundary: exactly 200ms gap -> closed (>= rule)", () => {
  // Pad words so prev ends at 1000 and next starts at 1200 (gap == 200ms).
  const boundaryWords = [
    { word: "a", start_ms: 800, end_ms: 1000 },
    { word: "b", start_ms: 1200, end_ms: 1400 },
  ];
  // Anywhere in [1000, 1200) should be closed because gap >= PAUSE_MS.
  assert.equal(activeShape(1000, boundaryWords), "closed");
  assert.equal(activeShape(1100, boundaryWords), "closed");
  assert.equal(activeShape(1199, boundaryWords), "closed");
});

test("PAUSE_MS boundary: 199ms gap -> open", () => {
  const boundaryWords = [
    { word: "a", start_ms: 800, end_ms: 1000 },
    { word: "b", start_ms: 1199, end_ms: 1399 },
  ];
  assert.notEqual(activeShape(1100, boundaryWords), "closed");
});
