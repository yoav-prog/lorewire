// Single source of truth for the branded-title length policy. Three
// consumers read these numbers and must never drift:
//   - the generator mirror (lib/title-regenerator.ts) that rewrites a title,
//   - the Content-inbox "too long" filter (lib/repo.ts) that finds bad rows,
//   - the bulk fix (app/admin/actions.ts) that regenerates them.
//
// Kept deliberately dependency-free — no "server-only", no repo import — so
// repo.ts can import it without a cycle (title-regenerator.ts imports repo).
//
// The Python pipeline holds the canonical copy of these same numbers in
// pipeline/stages.py (TITLE_MAX_CHARS / TITLE_MAX_WORDS). If the two ever
// drift, the symptom is "the admin filter flags titles the pipeline just
// produced" — easy to spot, fix by re-aligning the two constants.

export const TITLE_MAX_CHARS = 50;
export const TITLE_MAX_WORDS = 8;

/** Word count under the same rule the generator + pipeline use: collapse any
 *  run of whitespace, ignore leading/trailing blanks. Empty string → 0. */
export function titleWordCount(title: string): number {
  const trimmed = title.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** Is this title over the hard cap (either bound)? Null / blank titles are
 *  NOT too long — an absent title is a different problem than an over-long
 *  one, and the filter/fix only target the latter. */
export function isTitleTooLong(title: string | null | undefined): boolean {
  if (!title) return false;
  const trimmed = title.trim();
  if (!trimmed) return false;
  return trimmed.length > TITLE_MAX_CHARS || titleWordCount(trimmed) > TITLE_MAX_WORDS;
}
