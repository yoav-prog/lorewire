// Canonical source of truth for story categories.
//
// Before this file, the six-item category set was duplicated across six
// places that had to be edited in lockstep: the `Cat` union + `CAT` color
// map (stories.ts), the admin `CATEGORIES` list (admin/ui.ts), the
// homepage `CATEGORY_RAILS` + `GLYPH_BY_CAT` (homepage-rails.ts), the
// bulk-action validation Set (admin/actions.ts), and the Python
// `STORY_CATEGORIES` + `SUBREDDIT_CATEGORY` (pipeline/stages.py). Every
// TS site now derives from here, so a category change is one edit; the
// Python mirror is guarded by manifest.test.ts so the two runtimes
// can't drift silently.
//
// Client-safe on purpose (no "server-only" import): stories.ts imports
// it and is pulled into client bundles. Pure data + pure helpers only.
//
// Plan: _plans/2026-07-01-category-taxonomy-multitag.md. The data-driven
// admin-managed table + the ~17 granular tags land in PR2+; PR1 only
// collapses today's six lists into this manifest with no behavior change.

// Ordered category labels. `as const` preserves the literal union so
// `Cat` and `(typeof CATEGORIES)[number]` stay exact at every call site.
// Order matches the historical admin/ui.ts `CATEGORIES` order.
export const CATEGORY_LABELS = [
  "Drama",
  "Entitled",
  "Humor",
  "Wholesome",
  "Dating",
  "Roommate",
] as const;

export type Cat = (typeof CATEGORY_LABELS)[number];

export interface CategoryDef {
  /** Display label, also the current DB value. */
  label: Cat;
  /** Immutable kebab key. Not yet used as a join key in PR1; it becomes
   *  the stable identifier when categories move into the DB (PR2). */
  slug: string;
  /** Card color, hex. Used as an inline style and mirrored by the
   *  `--color-cat-<slug>` token in globals.css. */
  color: string;
  /** Card glyph. */
  glyph: string;
  /** Homepage curation surface key for this category's rail. */
  railSurface: string;
  /** Public rail header. */
  railTitle: string;
  /** Subreddits the pipeline's fast-path classifier maps to this
   *  category (mirrors pipeline/stages.py:SUBREDDIT_CATEGORY). */
  subreddits: string[];
}

// The registry, keyed by label so every `Cat` has exactly one entry.
// Values are byte-identical to what the six call sites hardcoded before
// this manifest existed — PR1 is a pure de-duplication.
export const CATEGORY_MANIFEST: Record<Cat, CategoryDef> = {
  Drama: {
    label: "Drama",
    slug: "drama",
    color: "#9B3A30",
    glyph: "/",
    railSurface: "drama_row",
    railTitle: "Pure Drama",
    subreddits: ["pettyrevenge", "maliciouscompliance"],
  },
  Entitled: {
    label: "Entitled",
    slug: "entitled",
    color: "#C06234",
    glyph: "$",
    railSurface: "entitled_row",
    railTitle: "Audacity: Entitled People",
    subreddits: ["amitheasshole", "entitledparents", "choosingbeggars"],
  },
  Humor: {
    label: "Humor",
    slug: "humor",
    color: "#C9A227",
    glyph: "!",
    railSurface: "humor_row",
    railTitle: "Humor & Awkward Moments",
    subreddits: ["tifu"],
  },
  Wholesome: {
    label: "Wholesome",
    slug: "wholesome",
    color: "#2C7E78",
    glyph: "+",
    railSurface: "wholesome_row",
    railTitle: "Wholesome Wins",
    subreddits: ["mademesmile", "humansbeingbros"],
  },
  Dating: {
    label: "Dating",
    slug: "dating",
    color: "#A8466A",
    glyph: "?",
    railSurface: "dating_row",
    railTitle: "Dating Disasters",
    subreddits: ["relationships", "relationship_advice"],
  },
  Roommate: {
    label: "Roommate",
    slug: "roommate",
    color: "#5B3B8A",
    glyph: "#",
    railSurface: "roommate_row",
    railTitle: "Roommate Files",
    subreddits: ["roommates"],
  },
};

// Registry as an array in canonical label order.
export const CATEGORY_DEFS: readonly CategoryDef[] = CATEGORY_LABELS.map(
  (label) => CATEGORY_MANIFEST[label],
);

/** label -> hex. Mirrors the historical `CAT` map in stories.ts. */
export const CAT_COLORS: Record<Cat, string> = Object.fromEntries(
  CATEGORY_LABELS.map((label) => [label, CATEGORY_MANIFEST[label].color]),
) as Record<Cat, string>;

/** label -> glyph. Mirrors the historical `GLYPH_BY_CAT` in homepage-rails.ts. */
export const CATEGORY_GLYPHS: Record<Cat, string> = Object.fromEntries(
  CATEGORY_LABELS.map((label) => [label, CATEGORY_MANIFEST[label].glyph]),
) as Record<Cat, string>;

/** subreddit (lowercased) -> category label. Mirrors the Python
 *  SUBREDDIT_CATEGORY map; the pipeline uses it as the fast-path /
 *  fallback classifier. Compared unordered against the Python side in
 *  manifest.test.ts (a lookup map, so insertion order is irrelevant). */
export const SUBREDDIT_CATEGORY: Record<string, Cat> = Object.fromEntries(
  CATEGORY_DEFS.flatMap((def) =>
    def.subreddits.map((sub) => [sub, def.label] as const),
  ),
);

// Homepage category rails, in RENDER order. This order deliberately
// differs from CATEGORY_LABELS — Drama renders LAST on the homepage —
// so it's kept explicit rather than derived from the label order.
export const CATEGORY_RAIL_ORDER: readonly Cat[] = [
  "Entitled",
  "Humor",
  "Wholesome",
  "Dating",
  "Roommate",
  "Drama",
];

export interface CategoryRailEntry {
  surface: string;
  title: string;
  cat: Cat;
}

/** Ordered rail entries. homepage-rails.ts builds its typed
 *  `CATEGORY_RAILS` from this so the rail set, titles, and surfaces all
 *  trace back to the manifest. */
export const CATEGORY_RAIL_ENTRIES: readonly CategoryRailEntry[] =
  CATEGORY_RAIL_ORDER.map((cat) => ({
    surface: CATEGORY_MANIFEST[cat].railSurface,
    title: CATEGORY_MANIFEST[cat].railTitle,
    cat,
  }));

/** Closed-set membership guard. Mirrors the `isHomepageSurface` pattern
 *  in homepage-curation-shared.ts. */
export function isCategoryLabel(v: unknown): v is Cat {
  return (
    typeof v === "string" &&
    (CATEGORY_LABELS as readonly string[]).includes(v)
  );
}
