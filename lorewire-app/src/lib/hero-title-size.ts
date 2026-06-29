// Length-aware font sizing for the hero title.
//
// The hero ships a fixed-size <h1> on both shells (desktop = 84px,
// mobile = 46px). For brand-voice titles those sizes are correct —
// "THE $800 ENVELOPE" sits perfectly inside the 620px desktop column.
// But the pipeline can still leak a long title to the public hero on
// rare failure paths (plan: _plans/2026-06-25-title-length-gate.md),
// and a 99-character title at 84px wraps into nine lines and visually
// dominates the hero, crowding out the synopsis and the action row.
//
// This is the render-time floor: pick a font size by character bucket
// so even a too-long title stays composed. The buckets keep the
// "well-sized title" case rendering identically to today's hardcoded
// values; only the over-length tail shrinks.

export type HeroBucket = "short" | "medium" | "long" | "extra-long";

/** Bucket a title by character count. Splitting this out from the
 *  font-size pickers keeps the buckets stable across surfaces and
 *  testable in isolation. */
export function heroTitleBucket(title: string): HeroBucket {
  const chars = (title ?? "").length;
  if (chars <= 30) return "short";
  if (chars <= 50) return "medium";
  if (chars <= 80) return "long";
  return "extra-long";
}

/** Desktop hero size. Matches the pre-floor 84px for short titles. */
export function heroTitleFontSizeDesktop(title: string): number {
  switch (heroTitleBucket(title)) {
    case "short":
      return 84;
    case "medium":
      return 64;
    case "long":
      return 48;
    case "extra-long":
      return 36;
  }
}

/** Mobile hero size. Matches the pre-floor 46px for short titles. */
export function heroTitleFontSizeMobile(title: string): number {
  switch (heroTitleBucket(title)) {
    case "short":
      return 46;
    case "medium":
      return 36;
    case "long":
      return 28;
    case "extra-long":
      return 22;
  }
}
