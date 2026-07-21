// Key derivations for the per-category settings the pipeline + publishers
// read at run time. Centralised so the admin pages that WRITE these keys
// and the snapshot loaders that READ them cannot drift on the derivation.
//
// The category set itself is DB-driven (the `categories` table, 18 active
// granular rows); callers iterate `listCategories()` labels and derive the
// key per label with these helpers. Keys embed the LABEL because that is
// exactly what every consumer looks up with (the story's denormalized
// `stories.category` value):
//   - pipeline/voiceovers.py       -> voiceovers.category.<Label>
//   - pipeline/shorts_auto.py      -> shorts.auto.category.<Label>
//   - pipeline/stages.py           -> hero.category_default.<label lowercased>
//   - publish-to-youtube.ts        -> publisher.youtube.tags.<Label>
//   - publish-to-tiktok.ts         -> publisher.tiktok.hashtags.<Label>
//   - resolve_caption_template_for -> caption.cat.<Label>.*
//
// Deliberately NOT "server-only": pure string functions, importable from
// any boundary. Plan: _plans/2026-07-02-per-category-settings-granular.md.

/** Per-category hero-style default, read by
 *  `pipeline/stages.py:resolve_hero_style` as
 *  `hero.category_default.<category.lower()>`. */
export function heroCategoryDefaultKey(label: string): string {
  return `hero.category_default.${label.toLowerCase()}`;
}

/** Per-category auto-short override ("" inherit / "on" / "off"), read by
 *  `pipeline/shorts_auto.py:resolve_short_auto_config`. */
export function shortsAutoCategoryKey(label: string): string {
  return `shorts.auto.category.${label}`;
}
