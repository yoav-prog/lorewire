// Pure shape-selection logic for the MouthSwap motion beat, split out from
// MouthSwap.tsx so it can be exercised without rendering. Two functions, no
// React, no Remotion — easy to reason about and easy to validate.
//
// Contract (locked by the cases in mouth-timing.test.mjs):
//   1. Empty alignment word list -> "closed".
//   2. elapsedMs inside a word's [start_ms, end_ms) -> open, cycling through
//      OPEN_CYCLE every OPEN_HOLD_MS so consecutive frames don't repeat.
//   3. elapsedMs in a gap between two adjacent words where the gap is shorter
//      than PAUSE_MS -> open (mid-sentence breath reads as still talking).
//   4. elapsedMs in a gap >= PAUSE_MS, before the first word, or after the
//      last word -> "closed".
//   5. Shape is deterministic per (elapsedMs, words): re-renders pick the
//      same shape so frame extracts are reproducible.
//
// Words are assumed start-sorted (the pipeline writes them in narration order).

import { OPEN_CYCLE, type MouthShape } from "./mouths";

export interface AlignmentWord {
  word: string;
  start_ms: number;
  end_ms: number;
}

export const PAUSE_MS = 200;
export const OPEN_HOLD_MS = 90;

export function activeShape(
  elapsedMs: number,
  words: AlignmentWord[],
): MouthShape {
  if (words.length === 0) return "closed";

  // Linear walk. Per-frame word counts are small and linear is easier to
  // reason about than a binary search around the open/closed boundary.
  let currentWord: AlignmentWord | null = null;
  let prevWord: AlignmentWord | null = null;
  let nextWord: AlignmentWord | null = null;
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

export function pickOpen(localMs: number, anchorMs: number): MouthShape {
  // Anchor the cycle to the word boundary so the shape feels phase-locked
  // to speech onset rather than drifting with the composition clock.
  const idx =
    Math.floor(localMs / OPEN_HOLD_MS) + Math.floor(anchorMs / 1000);
  return OPEN_CYCLE[Math.abs(idx) % OPEN_CYCLE.length];
}
