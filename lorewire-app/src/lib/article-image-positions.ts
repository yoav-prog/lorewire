// Distribute a story's scene images through its article body.
//
// Both AppShell's and DesktopShell's GenArticle render the same magazine
// layout: paragraphs interleaved with scene illustrations. The math that
// decides which scene lands after which paragraph used to live inline in
// both files, which (a) drifted between the two surfaces and (b) hid a
// failure mode the live homepage exposed: AI-generated bodies that arrive
// as a single paragraph blob with no `\n\n` separators rendered as one
// wall of text, and the inline math bailed when paragraph count was below
// 3, so no images surfaced even though the story had scenes ready to draw.
//
// `splitArticleParagraphs` returns at least one chunk for any non-empty
// body and falls back to single-newline then sentence chunking so an
// otherwise wall-of-text body still gives the distributor room to work.
//
// `placeArticleImages` only ever places a scene in a gap that has body
// text both before AND after it. A story often carries more scenes than
// its article body has room for (a short's 6-8 doodle frames against a
// four-paragraph write-up); the surplus scenes are dropped rather than
// stacked below the last line. The article is a read, not a gallery — an
// illustration with no surrounding prose reads as a dump, so we would
// rather show fewer images than trail a strip of them past the text.

export interface ArticleImagePlacement {
  /** Scene URL keyed by the paragraph index it renders AFTER. Every placed
   *  scene is followed by at least one more paragraph, so no illustration
   *  ever trails past the end of the article text. */
  inline: Map<number, string>;
}

/** Split an article body into paragraphs for the magazine renderer.
 *
 * Order of precedence:
 *   1. Double-newline split — the canonical paragraph break that the
 *      pipeline writes.
 *   2. Single-newline split — some AI-generated bodies arrive with single
 *      breaks instead of doubled ones.
 *   3. Sentence chunking — a single wall-of-text blob is grouped into
 *      two-sentence chunks so the image distributor still has slots.
 *
 * Always returns at least one entry for a non-empty body. Empty bodies
 * return `[]` so the caller can short-circuit. */
export function splitArticleParagraphs(body: string | null | undefined): string[] {
  if (!body) return [];
  const byDouble = body
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (byDouble.length > 1) return byDouble;
  const bySingle = body
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (bySingle.length > 1) return bySingle;
  // Single-blob body. Chunk on sentence boundaries (., !, ?) so the
  // distributor has somewhere to put scene images. Two sentences per
  // chunk keeps the resulting paragraphs in the same readable cadence
  // the writer would have hit manually.
  const sentences = body.match(/[^.!?\n]+[.!?]+\s*/g);
  if (!sentences || sentences.length < 3) {
    const trimmed = body.trim();
    return trimmed ? [trimmed] : [];
  }
  const chunks: string[] = [];
  for (let i = 0; i < sentences.length; i += 2) {
    const chunk = sentences.slice(i, i + 2).join("").trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

/** Distribute scene images across an article body's paragraphs.
 *
 * Scenes only land in interior gaps — after paragraph 1 through paragraph
 * `paraCount - 2` — so every illustration has a paragraph of lead-in
 * before it and at least one paragraph of text after it. That leaves
 * `paraCount - 2` usable slots; a body with fewer than three paragraphs
 * has none and renders text-only rather than trailing a stray image below
 * the last line.
 *
 * When a story carries more scenes than there are slots, the surplus is
 * dropped. `inline.size` is therefore `min(images.length, paraCount - 2)`,
 * never more. Image i lands after paragraph
 * `floor((i+1) * paraCount / (count+1))`, the long-standing cadence that
 * put a 10-paragraph / 3-scene body's images after paragraphs 2, 5, 7. */
export function placeArticleImages(
  paraCount: number,
  images: readonly string[],
): ArticleImagePlacement {
  const inline = new Map<number, string>();
  // Interior gaps only: after paragraph 1 .. paragraph paraCount-2. Fewer
  // than three paragraphs means no gap can be flanked by text on both
  // sides, so nothing is placed.
  const slots = paraCount - 2;
  if (images.length === 0 || slots <= 0) return { inline };
  const count = Math.min(images.length, slots);
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(((i + 1) * paraCount) / (count + 1));
    // `count <= paraCount - 2` keeps the even spread inside [1, paraCount-2]
    // with distinct slots; the clamp is a belt-and-braces guard.
    const slot = Math.max(1, Math.min(paraCount - 2, idx));
    inline.set(slot, images[i]!);
  }
  return { inline };
}
