# Per-category settings: migrate voiceovers / settings / socials / templates to the granular taxonomy

**Date:** 2026-07-02
**Status:** Executing (follow-up Yoav requested after PR #199).
**Surfaces:** /admin/voiceovers, /admin/settings, /admin/settings/socials, /admin/templates, admin/actions.ts (hero style snapshot + validator).

## Why this is a bug fix, not a cosmetic update

Stories now carry granular labels in `stories.category` (18 active categories, PR #199 context). Every per-category setting is READ by the consumer using the story's label at run time:

| Setting | Consumer | Lookup key |
|---|---|---|
| `voiceovers.category.<Label>` | pipeline/voiceovers.py `resolve_voiceover` | story label verbatim |
| `shorts.auto.category.<Label>` | pipeline/shorts_auto.py `resolve_short_auto_config` | story label verbatim |
| `hero.category_default.<label lowercased>` | pipeline/stages.py `resolve_hero_style` | `category.lower()` |
| `publisher.youtube.tags.<Label>` | publish-to-youtube.ts | `context.category` (label) |
| `publisher.tiktok.hashtags.<Label>` | publish-to-tiktok.ts | `context.category` (label) |
| `caption.cat.<Label>.*` | pipeline `resolve_caption_template_for` | story label |
| `homepage.rotating_category_today` | homepage-data.ts via `isRotatingCategorySurface` | granular rail SLUG (closed 8-item set) |

The admin pages still write keys for the legacy six labels, which no current story carries — so every per-category override the admin sets today is dead on arrival (the consumers fall through to the global default). Worse, the rotating-rail dropdown on /admin/settings offers the LEGACY manifest surfaces (`drama_row` etc.) while the resolver validates against the granular slugs — every value the dropdown can produce is invalid and silently falls back to auto-rotation.

## Changes (label-keyed, zero consumer changes)

Keys stay derived from labels exactly as the consumers read them; only the admin surfaces change which categories they iterate:

1. **voiceovers/page.tsx** — per-category voice rows iterate active DB categories (was manifest six). The save action already validates against the DB set (PR #199).
2. **settings/page.tsx** —
   - shorts.auto category overrides iterate active DB categories;
   - hero per-category pickers derive from active DB categories (`hero.category_default.<label.toLowerCase()>`), each wrapped in a nested `<details>` so 18 radio-grids don't wall the section;
   - rotating-rail dropdown offers `ROTATING_CATEGORY_SURFACES` (the resolver's actual closed set) labeled from the granular registry — fixes the dead dropdown.
3. **settings/socials/page.tsx** — YT tags + TT hashtags per-category fields iterate active DB categories.
4. **templates/page.tsx** — category scope tabs iterate active DB categories (threaded into ScopeSwitcher as a prop).
5. **actions.ts** — `loadHeroStyleSettings` derives per-category keys from the active DB set instead of the hardcoded six; `saveSettingAction` validates any `hero.category_default.*` key with the style-id validator via prefix match (static six-entry list would go stale the moment an admin adds a category).

Legacy-keyed settings rows are left in place, not deleted and not shown: a straggler story still carrying a legacy label keeps hitting its legacy override (correct), and nothing orphans.

## Out of scope (flagged)

- `CATEGORY_STYLE_WHITELIST` (Python) still maps only the legacy six; granular categories auto-pick from Drama's whitelist via the existing fallback. Works, but per-category variety needs an editorial pass over 18 whitelists — separate task.
- `DEFAULT_HASHTAGS_BY_CATEGORY` / per-category default tags in the publisher libs: legacy-keyed FALLBACKS used only when no setting exists; base defaults cover granular labels. Editorial follow-up.
- Slug-keyed settings (rename-proof) — deferred until the admin category CRUD (taxonomy PR4) exists; today labels cannot be renamed via UI so label keys are stable.

## Security
No new write surface. saveSettingAction's validator coverage is widened (prefix match) not narrowed; hero style values still validate against the closed style-id registry. Category lists come from the admin-owned DB table.

## Observability
Existing `[admin setting]` accept/reject logs cover the new keys. No new log points needed; the settings pages are read-render only.

## Settings audit
This IS the settings audit. No new knobs invented; the existing knobs get the correct option sets.

## Testing
- Unit: loadHeroStyleSettings derives keys from active categories (mock/seed DB); saveSettingAction accepts `hero.category_default.<granular>` with a valid style id and rejects junk style ids on the same key.
- Existing suites must stay green.

## Deploy
Same branch flow as PR #199 (separate branch off main, PR, no push without approval).
