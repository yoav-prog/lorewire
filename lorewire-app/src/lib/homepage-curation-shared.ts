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
  // The 8 rail-flagged categories from the 18-set (PR5 read-path flip). The
  // surface key IS the category slug so /c/<slug>, curation, and the rotating
  // slot all share one identifier.
  "entitled-people",
  "family-feuds",
  "cheating-betrayal",
  "wedding-drama",
  "workplace",
  "dating-disasters",
  "revenge-karma",
  "wholesome-wins",
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
  "entitled-people": null,
  "family-feuds": null,
  "cheating-betrayal": null,
  "wedding-drama": null,
  workplace: null,
  "dating-disasters": null,
  "revenge-karma": null,
  "wholesome-wins": null,
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
  "entitled-people",
  "family-feuds",
  "cheating-betrayal",
  "wedding-drama",
  "workplace",
  "dating-disasters",
  "revenge-karma",
  "wholesome-wins",
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

// ─── Cold-start floor (slice F of homepage redesign v1) ─────────────────────
//
// Floor-eligible rails hide entirely until they have at least N published
// cards. The shells already drop empty rails on `> 0`; the floor lifts
// that bar so a half-built rail (1-3 posters) doesn't read as "the
// product is broken." Per-rail eligibility lives in the shells (slice
// F.3); the constant + parse helpers are the contract.
//
// HISTORICAL CONTEXT — read before changing this:
//
// PR #66 introduced a hard-coded MIN_PUBLIC_RAIL_SIZE = 4, which hid
// EVERY rail on production because an underlying fallback bug was
// returning thin counts. PR #67 fixed the real bug (filter by
// isPublishedStory BEFORE slicing) AND removed the floor. The memory
// `feedback_investigate_inventory_before_hiding_ui.md` codifies the
// rule: investigate inventory before adding hide-if-thin thresholds.
//
// Re-introducing the floor now is safe because #67's count fix is
// in place — the floor sees a TRUE published count and won't blank
// the homepage when the data is actually there. Defensive measures:
// the value is admin-tunable via the setting below (set to 0 to
// disable), the SSR seed logs the resolved value, and the personalized
// rails (continue, minority) + special-render rails (hero, top10) are
// SKIPPED so a thin personalized signal still surfaces.
//
// Plan: _plans/2026-06-26-homepage-redesign-v1.md.

/** Default minimum published cards a floor-eligible rail must have
 *  before it renders. 4 matches the original PR #66 design target —
 *  enough cards to fill the visible portion of a horizontally
 *  scrolling rail without the next-card cue. */
export const COLD_START_FLOOR_DEFAULT = 4;

/** Settings key for the admin override. Set the value to 0 to disable
 *  the floor entirely (legacy `> 0` gate); other positive integers
 *  raise/lower the threshold. */
export function coldStartFloorSettingKey(): string {
  return "homepage.cold_start_floor";
}

/** Strict non-negative-integer parse. Blank / malformed / negative
 *  falls through to the default; 0 is honoured (turns the floor off).
 *
 *  Note: unlike the minority-vote threshold parser, this one DOES
 *  accept 0 — "disable the floor" is a legitimate admin choice (e.g.
 *  during a content-thin launch window) and a useful escape hatch
 *  given the PR #66 history. */
export function parseColdStartFloor(
  raw: string | null | undefined,
): number {
  if (raw === null || raw === undefined) return COLD_START_FLOOR_DEFAULT;
  const trimmed = raw.trim();
  if (trimmed === "") return COLD_START_FLOOR_DEFAULT;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 0) return COLD_START_FLOOR_DEFAULT;
  return n;
}
