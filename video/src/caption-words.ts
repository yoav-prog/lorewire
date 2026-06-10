// findActiveWordIndex picks the word the karaoke highlight should land on at
// the current elapsed time. Linear scan because chunks have at most ~4 words
// and the cost of a binary search abstraction outweighs the savings here.
// Ported from yt-studio's src/lib/shorts-caption-words.ts.

import type { ShortCaptionWord } from "./types";

export function findActiveWordIndex(
  words: ShortCaptionWord[],
  elapsedMs: number,
): number {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (elapsedMs >= w.start_ms && elapsedMs < w.end_ms) {
      return i;
    }
  }
  // After the last word's end, treat it as still active until the chunk fades
  // out — otherwise the highlight blinks off at the moment a viewer's eye
  // would still be parsing the line.
  if (words.length > 0 && elapsedMs >= words[words.length - 1].end_ms) {
    return words.length - 1;
  }
  return -1;
}
