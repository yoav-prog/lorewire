// Data-driven category visuals (PR5 read-path flip,
// _plans/2026-07-01-category-taxonomy-multitag.md). Resolves ANY category
// label or slug — the 18 granular, the 6 legacy, or an admin-added one — to a
// color + glyph, WITHOUT the static Tailwind `bg-cat-*` classes that can't
// exist for runtime slugs. Consumers render `categoryVisual(cat).color` as an
// inline style. Client-safe: pure data from the manifest + granular set.

import { GRANULAR_CATEGORIES } from "./granular";
import { CATEGORY_DEFS } from "./manifest";

export interface CategoryVisual {
  label: string;
  slug: string;
  color: string;
  glyph: string;
}

// Neutral fallback for an unknown category (e.g. a story whose tag was
// removed). A muted grey + a dot so it never renders colorless or crashes.
const DEFAULT_COLOR = "#6B6B6B";
const DEFAULT_GLYPH = "•";

// label -> visual and slug -> visual. Granular (the live 18) wins over the
// legacy 6 when a label/slug collides.
const BY_LABEL = new Map<string, CategoryVisual>();
const BY_SLUG = new Map<string, CategoryVisual>();

function register(label: string, slug: string, color: string, glyph: string): void {
  const v: CategoryVisual = { label, slug, color, glyph };
  BY_LABEL.set(label, v);
  BY_SLUG.set(slug, v);
}

for (const d of CATEGORY_DEFS) register(d.label, d.slug, d.color, d.glyph);
for (const c of GRANULAR_CATEGORIES) register(c.label, c.slug, c.color, c.glyph);

/** Resolve a story's category (a label OR a slug) to its visual. Unknown
 *  values return a neutral fallback carrying the original text as the label,
 *  so the UI degrades gracefully instead of crashing or going colorless. */
export function categoryVisual(
  labelOrSlug: string | null | undefined,
): CategoryVisual {
  if (!labelOrSlug) {
    return { label: "", slug: "", color: DEFAULT_COLOR, glyph: DEFAULT_GLYPH };
  }
  return (
    BY_LABEL.get(labelOrSlug) ??
    BY_SLUG.get(labelOrSlug) ?? {
      label: labelOrSlug,
      slug: labelOrSlug,
      color: DEFAULT_COLOR,
      glyph: DEFAULT_GLYPH,
    }
  );
}

export function categoryColor(labelOrSlug: string | null | undefined): string {
  return categoryVisual(labelOrSlug).color;
}

export function categoryGlyph(labelOrSlug: string | null | undefined): string {
  return categoryVisual(labelOrSlug).glyph;
}
