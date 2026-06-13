// Setting parser for `video.preview_segment_fit` (2026-06-14 toggle).
//
// Two-state enum: "cover" (the original full-bleed-may-crop behavior) and
// "contain" (letterbox so an aspect mismatch shows up as visible black
// bars). Anything unknown / null / empty resolves to "cover" so a fresh
// install or a typo in the settings table is byte-identical to the
// pre-toggle behavior — admins opt INTO contain mode explicitly.
//
// Pure, no I/O — kept in `lib/` so page.tsx can call it and a unit test
// can exercise every branch without spinning up Remotion or the Player.

export type PreviewSegmentFit = "cover" | "contain";

export const DEFAULT_PREVIEW_SEGMENT_FIT: PreviewSegmentFit = "cover";

/** Normalize a raw setting value (string from `getSetting`, or
 *  `null` / `undefined` when unset) into the typed `PreviewSegmentFit`
 *  enum. Falls through to "cover" so the unset state matches the
 *  pre-toggle behavior everyone's used to. */
export function parsePreviewSegmentFit(
  raw: string | null | undefined,
): PreviewSegmentFit {
  if (typeof raw !== "string") return DEFAULT_PREVIEW_SEGMENT_FIT;
  const v = raw.trim().toLowerCase();
  if (v === "contain") return "contain";
  return DEFAULT_PREVIEW_SEGMENT_FIT;
}
