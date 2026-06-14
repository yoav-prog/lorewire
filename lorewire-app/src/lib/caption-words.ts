// Per-word helpers shared by the editor preview's CaptionBand and any
// other surface that needs to walk a caption chunk word-by-word.
//
// MUST stay byte-identical to `video/src/caption-words.ts` (with the
// import path swapped). The renderer can't import from lorewire-app, so
// the two files are kept in sync by the parity test in
// `tests/lib/caption-words.test.ts`. When you change a function body
// here, mirror it there in the same PR.

import type {
  ShortCaptionChunk,
  ShortCaptionWord,
} from "@/lib/video-config";

// Returns the word the karaoke / per-word highlight should land on at
// the given elapsedMs. Linear scan because chunks have at most ~4 words
// and the cost of a binary-search abstraction outweighs the savings.
//
// Behavior:
//   - elapsedMs in [start_ms, end_ms) of word i → returns i
//   - elapsedMs >= last word's end_ms        → returns last index
//     (so the highlight doesn't blink off in the trailing silence of a
//     chunk while the viewer's eye is still parsing the line)
//   - elapsedMs in a silent gap between words → returns -1
//   - elapsedMs before the first word        → returns -1
//   - empty words                            → returns -1
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
  if (words.length > 0 && elapsedMs >= words[words.length - 1].end_ms) {
    return words.length - 1;
  }
  return -1;
}

// Pick per-word timings for a chunk. Prefers the alignment-derived
// `chunk.words` when present; falls back to an evenly-distributed split
// of `chunk.text` across the chunk's span so a chunk without alignment
// still has a usable per-word timeline for the highlight to track.
//
// The fallback mirrors `proportionalWords` from the renderer so a chunk
// that's missing word timings looks identical in the preview and the
// final MP4.
export function splitChunkWords(chunk: ShortCaptionChunk): ShortCaptionWord[] {
  if (chunk.words && chunk.words.length > 0) return chunk.words;
  const tokens = chunk.text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return [];
  const span = Math.max(1, chunk.end_ms - chunk.start_ms);
  const per = span / tokens.length;
  return tokens.map((token, i) => ({
    word: token,
    start_ms: Math.round(chunk.start_ms + i * per),
    end_ms: Math.round(chunk.start_ms + (i + 1) * per),
  }));
}
