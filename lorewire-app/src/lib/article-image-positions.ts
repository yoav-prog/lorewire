// Distribute a story's scene images through its article body.
//
// Both AppShell's and DesktopShell's GenArticle render the same magazine
// layout: paragraphs interleaved with scene illustrations. The math that
// decides which scene lands after which paragraph used to live inline in
// both files, which (a) drifted between the two surfaces and (b) hid two
// failure modes the live homepage exposed:
//
//   1. AI-generated bodies that arrive as a single paragraph blob with no
//      `\n\n` separators rendered as one wall of text. The inline math
//      bailed when paragraph count was below 3, so no images surfaced even
//      though the story had three scenes ready to draw.
//
//   2. When the inline distribution skipped some images (e.g. a short
//      body with more scenes than slots), the leftover scenes silently
//      dropped instead of showing up under the body.
//
// `splitArticleParagraphs` returns at least one chunk for any non-empty
// body and falls back to single-newline then sentence chunking so an
// otherwise wall-of-text body still gives the distributor room to work.
// `placeArticleImages` always returns every input image — either inline
// in the `Map<paragraphIndex, url>` or in the `extras` array that the
// caller renders as a trailing strip below the article body.

export interface ArticleImagePlacement {
  /** Scene URL keyed by the paragraph index it should render AFTER. */
  inline: Map<number, string>;
  /** Scenes that didn't get an inline slot (single-paragraph body, more
   *  scenes than usable positions, etc.). Caller renders these as a
   *  trailing strip so no scene is silently dropped. */
  extras: string[];
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
 * - With paraCount >= 3, image i lands after paragraph
 *   `floor((i+1) * N / (M+1))` (the original distribution that keeps
 *   the first image off the top and the last off the footer).
 * - With paraCount of 1 or 2 (a very short body), the first image still
 *   lands after paragraph 0 so the reader sees at least one
 *   illustration. Remaining scenes flow to `extras`.
 * - Collisions (two scenes that round to the same paragraph slot) push
 *   the loser to `extras` instead of overwriting the inline winner.
 *
 * Always preserves every input image — sum of `inline.size + extras.length`
 * equals `images.length`. */
export function placeArticleImages(
  paraCount: number,
  images: readonly string[],
): ArticleImagePlacement {
  if (images.length === 0 || paraCount <= 0) {
    return { inline: new Map(), extras: [] };
  }
  if (paraCount < 3) {
    // Place the first scene right after the opening paragraph; defer the
    // rest to the trailing strip. Without this branch the previous
    // single-paragraph-blob bug returned an empty inline map AND no
    // visible images at all.
    return {
      inline: new Map([[0, images[0]!]]),
      extras: images.slice(1),
    };
  }
  const inline = new Map<number, string>();
  const extras: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const idx = Math.floor(((i + 1) * paraCount) / (images.length + 1));
    const slot = Math.max(1, Math.min(paraCount - 1, idx));
    if (inline.has(slot)) {
      extras.push(images[i]!);
      continue;
    }
    inline.set(slot, images[i]!);
  }
  return { inline, extras };
}
