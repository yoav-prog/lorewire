// Phase 2 of _plans/2026-06-17-hero-style-registry.md.
//
// TS read-side of the hero style registry. The source of truth lives
// in `pipeline/stages.py:HERO_STYLES` + `CATEGORY_STYLE_WHITELIST` —
// `pipeline/scripts/sync_hero_styles.py` dumps both into
// `src/data/hero-styles.json` and the parity test
// (`pipeline/tests/test_hero_styles_sync.py`) re-runs that dump in
// memory + diffs against the committed JSON, so editing the Python
// side without re-syncing fails CI before merge.
//
// Why not generate the .ts file directly? Importing JSON gives us
// editor-friendly tree-shaking + no TS code-gen tool in the toolchain.
// The TS file just exposes typed accessors over the static data.
//
// The picker UI (step 4) reads:
//   - `HERO_STYLES` for the list of selectable styles (id, label, thumbnail).
//   - `CATEGORY_STYLE_WHITELIST` for the "Auto-picked from [...]" caption.
//   - `HeroStyleSource` to label the resolved row's origin layer.
//   - `isHeroStyleId` for cheap closed-enum validation on server actions.

import payload from "@/data/hero-styles.json";

export interface HeroStyle {
  /** Closed-enum key persisted on `stories.hero_style_id`. */
  id: string;
  /** Human-facing label the picker renders next to the thumbnail. */
  label: string;
  /** GCS URL of the pre-generated style sample, or null if step 3's
   *  thumbnail generation hasn't been run yet. The picker shows a
   *  placeholder block in that case. */
  thumbnail_url: string | null;
}

/** Ordered list of selectable styles. Order is the picker's display
 *  order (matches the Python registry's insertion order). */
export const HERO_STYLES: readonly HeroStyle[] = payload.styles as HeroStyle[];

/** Map keyed by style id so the resolved-style caption can do an O(1)
 *  lookup without walking the array. */
export const HERO_STYLES_BY_ID: Record<string, HeroStyle> = Object.fromEntries(
  HERO_STYLES.map((s) => [s.id, s]),
);

/** Per-category auto-pick whitelist. The Python resolver hashes the
 *  story id into one of these when no per-story / per-category / global
 *  default applies. Surfaced in the admin picker caption so the admin
 *  can see exactly which short-list produced the auto-pick. */
export const CATEGORY_STYLE_WHITELIST: Readonly<Record<string, readonly string[]>> =
  payload.category_whitelist as Record<string, readonly string[]>;

/** The four resolution layers the Python resolver walks, in order.
 *  Mirrors `pipeline/stages.py:HeroStyleSource`. The admin picker
 *  shows a different caption per source so the admin understands
 *  WHY this story landed on this style. */
export type HeroStyleSource =
  | "per_story"
  | "category_default"
  | "global_default"
  | "auto_hash";

/** Cheap closed-enum check for server-action input validation. Returns
 *  true when `id` is a known style id. Server actions that persist
 *  `stories.hero_style_id` MUST reject everything else so a malformed
 *  value can never poison the prompt downstream. */
export function isHeroStyleId(id: string | null | undefined): id is string {
  return typeof id === "string" && id in HERO_STYLES_BY_ID;
}

/** Human-facing caption for the picker. Translates a HeroStyleSource +
 *  category context into one short line the admin can scan. */
export function heroStyleSourceLabel(
  source: HeroStyleSource,
  category: string,
  whitelist: readonly string[] = [],
): string {
  switch (source) {
    case "per_story":
      return "Pinned for this story";
    case "category_default":
      return `Inherited from the ${category} category default`;
    case "global_default":
      return "Inherited from the global default";
    case "auto_hash":
      return whitelist.length > 0
        ? `Auto-picked from the ${category} short-list (${whitelist.join(", ")})`
        : `Auto-picked from the ${category} short-list`;
  }
}
