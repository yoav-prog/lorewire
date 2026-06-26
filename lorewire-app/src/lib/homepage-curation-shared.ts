// Client-safe surface enum + capacity map shared by the admin editor
// (client component) and the storage helpers in
// lib/homepage-curation.ts (server-only). Keeping this file free of
// any "server-only" / db imports means the CurationClient bundle
// doesn't accidentally drag the postgres driver into the browser.
//
// Storage helpers re-export from here so callers can keep importing
// from lib/homepage-curation and the indirection stays invisible.
//
// Plan: _plans/2026-06-16-homepage-curation.md.

export const HOMEPAGE_SURFACES = [
  "hero",
  "top10",
  "continue",
  "new_row",
  "entitled_row",
  "humor_row",
  "wholesome_row",
  "dating_row",
  "roommate_row",
  "drama_row",
] as const;
export type HomepageSurface = (typeof HOMEPAGE_SURFACES)[number];

// Per-surface fixed capacity. Hero is a rotation pool of up to 8 picks
// (the carousel auto-advances between them). TOP 10 is exactly 10. All
// other rails are unbounded; the admin page caps the picker at a
// reasonable rail size so a rail can't grow past what fits.
export const SURFACE_CAPACITY: Record<HomepageSurface, number | null> = {
  hero: 8,
  top10: 10,
  continue: null,
  new_row: null,
  entitled_row: null,
  humor_row: null,
  wholesome_row: null,
  dating_row: null,
  roommate_row: null,
  drama_row: null,
};

export function isHomepageSurface(v: unknown): v is HomepageSurface {
  return (
    typeof v === "string" &&
    (HOMEPAGE_SURFACES as readonly string[]).includes(v)
  );
}

// ─── Rotating category (slice E of homepage redesign v1) ────────────────────
//
// v1 homepage swaps the "render every category rail" loop for a single
// rotating slot that cycles deterministically through the six categories
// by UTC day. Same day -> same category for every visitor (the
// "site feels alive without per-user complexity" intent locked with
// Yoav). Admin override + kill switch live alongside so editorial can
// pin a category for today, or fall back to the legacy all-six render
// if the rotation isn't earning its slot yet.
//
// These helpers live here (not in homepage-rails.ts) because that
// module is "use client" and the SSR seed loader in
// lib/homepage-data.ts is "server-only" — both sides need the
// resolution math without crossing the boundary. Mirrors the
// polls.ts / polls-shared.ts split.
//
// Plan: _plans/2026-06-26-homepage-redesign-v1.md.

/** Surfaces participating in the rotating slot. Order matters — the
 *  modulo cycles through this exact sequence. Subset of
 *  HOMEPAGE_SURFACES (the six category rails only — hero / top10 /
 *  continue / new_row are not category cards). */
export const ROTATING_CATEGORY_SURFACES = [
  "entitled_row",
  "humor_row",
  "wholesome_row",
  "dating_row",
  "roommate_row",
  "drama_row",
] as const;
export type RotatingCategorySurface =
  (typeof ROTATING_CATEGORY_SURFACES)[number];

export function isRotatingCategorySurface(
  v: unknown,
): v is RotatingCategorySurface {
  return (
    typeof v === "string" &&
    (ROTATING_CATEGORY_SURFACES as readonly string[]).includes(v)
  );
}

/** Settings key for the admin override — pins a specific category for
 *  today regardless of the modulo. Value must be one of
 *  ROTATING_CATEGORY_SURFACES; blank / invalid / unset falls through
 *  to the auto-rotation. */
export function rotatingCategoryOverrideSettingKey(): string {
  return "homepage.rotating_category_today";
}

/** Settings key for the kill switch. Defaults to ON. When off the
 *  homepage falls back to rendering every category rail (pre-slice-E
 *  behavior) so editorial can roll back from the rotation without a
 *  deploy. */
export function rotatingCategoryEnabledSettingKey(): string {
  return "homepage.rotating_category_enabled";
}

/** Pick today's category surface from the rotation, deterministic per
 *  UTC day. Same day → same surface for every visitor, no per-user
 *  drift. `today` is a parameter so tests can fix the date and so the
 *  caller can pass a clock if it wants to.
 *
 *  Uses Math.floor against UTC milliseconds rather than the local-time
 *  Date methods on purpose — UTC keeps the rotation locked to 00:00 UTC
 *  worldwide, instead of shifting per visitor's timezone. */
export function pickRotatingCategoryByDay(
  today: Date = new Date(),
): RotatingCategorySurface {
  const dayNum = Math.floor(today.getTime() / 86_400_000);
  // JavaScript's % returns a negative remainder for negative day
  // numbers (pre-1970 dates). Add the modulus once and take it again
  // so the index is always non-negative.
  const idx =
    ((dayNum % ROTATING_CATEGORY_SURFACES.length) +
      ROTATING_CATEGORY_SURFACES.length) %
    ROTATING_CATEGORY_SURFACES.length;
  return ROTATING_CATEGORY_SURFACES[idx];
}

/** Resolves which category surface fills the rotating slot today.
 *  Resolution order:
 *
 *    1. Kill switch off (`enabled === false`) → null. Caller renders
 *       every category rail (legacy behavior).
 *    2. Admin override matches a known surface → use it. The override
 *       is the editorial escape hatch when "today should be drama
 *       regardless of what the modulo says."
 *    3. Otherwise → `pickRotatingCategoryByDay(today)`.
 *
 *  `enabled` is decoupled from the override on purpose: the admin can
 *  set an override AND turn the feature off (override is then unused
 *  until the feature is back on). Mirrors how the public-floor and
 *  rail-enabled settings keep their toggles separate from their
 *  values. */
export function resolveRotatingCategorySurface(
  enabled: boolean,
  override: string | null,
  today: Date = new Date(),
): RotatingCategorySurface | null {
  if (!enabled) return null;
  if (isRotatingCategorySurface(override)) return override;
  return pickRotatingCategoryByDay(today);
}
