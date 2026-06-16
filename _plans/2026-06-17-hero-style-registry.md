# Hero style registry — Netflix-style poster variety

**Date:** 2026-06-17
**Status:** Approved (scope locked with user, awaiting implementation start)
**Builds on:** Phase 1 hero-from-short character consistency (commit `739b25a`).

## Goal

Today every story in the same LoreWire category renders with the same hardcoded poster style (`CATEGORY_THUMBNAIL_STYLES` in [pipeline/stages.py](pipeline/stages.py)). All Entitled stories look like mid-century magazine illustrations; all Drama stories look like neo-noir posters. The catalog reads visually repetitive — open three Entitled posters and they're nearly indistinguishable except for the title typography.

Ship a small library of named poster styles (retro pulp, neo-noir, comic book, painted realism, vintage Hollywood, modern editorial), let admins pick per story (or accept a smart per-category auto-pick), surface the choice in the admin Settings + per-story edit page, and trigger the hero re-render against the new style via the existing `hero_from_short` queue path. Character consistency from Phase 1 is preserved — the i2i seed (the short's character) flows through every style.

## Why

- **Visual variety in the catalog.** A grid of homepage posters that all share one composition formula reads like template work, not curated content. Netflix-grade variety is table stakes for a streaming-style UI.
- **Phase 1 unlocked it.** Now that the same protagonist appears across Watch / hero / poster (commit `739b25a`), changing the style is a pure restyle — character identity is locked separately and won't drift.
- **Already-built plumbing.** `make_thumbnail_prompt` and `_regen_hero_from_short` already accept a style string today (via `CATEGORY_THUMBNAIL_STYLES[category]`). The change is "make the style a row-level pick, not a category-level fixed".

## Scope decisions (locked with the user)

1. **Default behavior — smart auto-pick.** When `stories.hero_style_id` is NULL the system picks a style *for* the admin instead of falling back to one fixed per-category default. The pick is deterministic per story (hash the story id) over a small **per-category whitelist** of 2–3 compatible styles, so the same story always restyles to the same default but different stories within the same category get different posters. Admin override always wins.
2. **6 styles at MVP.** Enough variety without picker fatigue. Add more by request after the library proves out.
3. **Pre-generated style thumbnails.** Each style ships with one ~3:4 sample image (same generic character, same composition, just the style differs) stored in GCS at `hero-style-thumbnails/<style_id>.png`. The picker shows the thumbnail, not just the label. One-time gen at deploy time — admin button "Generate style thumbnails" runs once and parks them.
4. **No retroactive re-render.** Changing the global default or a per-category default does NOT regenerate already-rendered heroes. They keep their current art until per-story regenerated via the existing `hero_from_short` button.
5. **Admin button preserves intent.** The "Restyle hero from short character" button on `/admin/stories/[id]` uses the resolved style (per-story → per-category → global). So the same button does double duty: applies the style picked for this story.

## Architecture

### Resolution chain

```
   story.hero_style_id            (admin picked this story specifically)
        ↓ NULL
   settings.hero.category_default.<cat>   (admin picked a default for this category)
        ↓ NULL
   settings.hero.global_style_id  (admin picked a global override)
        ↓ NULL
   deterministicPickFromWhitelist(story.id, CATEGORY_STYLE_WHITELIST[cat])
                                  (built-in smart default)
```

Resolution runs at **render time**, not at row-write time. A NULL row stays NULL — changing a setting affects future renders, never overwrites a row that's already pinned.

### Smart default — deterministic hash

```python
def deterministic_style_pick(story_id: str, allowed: list[str]) -> str:
    """Pick one of `allowed` deterministically from the story id so:
      - the same story always resolves to the same default (idempotent)
      - different stories within one category vary visually
      - re-rendering doesn't drift to a different style
    """
    digest = hashlib.sha1(story_id.encode("utf-8")).digest()
    return allowed[int.from_bytes(digest[:4], "big") % len(allowed)]
```

`CATEGORY_STYLE_WHITELIST` maps each category to 2–3 style ids that fit that category's tone:
- Entitled: `magazine_editorial`, `retro_pulp`, `comic_book`
- Drama: `neo_noir`, `painted_realism`, `documentary_still`
- Humor: `comic_book`, `vintage_hollywood`, `magazine_editorial`
- Wholesome: `illustrated_cover`, `painted_realism`, `vintage_hollywood`
- Dating: `magazine_editorial`, `illustrated_cover`, `painted_realism`
- Roommate: `documentary_still`, `comic_book`, `illustrated_cover`

(Exact whitelists are easy to tweak; they live as a `dict[Cat, list[str]]` in [pipeline/stages.py](pipeline/stages.py).)

### Style registry shape

```python
@dataclass(frozen=True)
class HeroStyle:
    id: str                       # stable kebab-case key, persisted on rows
    label: str                    # admin-facing display name
    system_prompt_band: str       # the style cue appended to the hero prompt
    thumbnail_url: str | None     # GCS URL of the pre-generated sample image

HERO_STYLES: dict[str, HeroStyle] = { ... }  # 6 entries at MVP
```

The 6 starter styles + prompt bands:

| id | label | prompt band (abbreviated) |
|---|---|---|
| `magazine_editorial` | Magazine editorial | Mid-century editorial poster, sat. red + burnt-orange on deep neutrals, mild caricature |
| `neo_noir` | Cinematic neo-noir | Moody single warm-light source, hyperdetailed realism, deep blacks, selective color |
| `retro_pulp` | Retro pulp paperback | 1950s pulp paperback, halftone shading, saturated reds and yellows, dramatic angle |
| `comic_book` | Comic book cover | Bold ink outlines, halftone, dynamic poster comp, pop palette |
| `painted_realism` | Painted realism | Oil-painted character study, museum lighting, deep tonal range |
| `vintage_hollywood` | Vintage Hollywood | Mid-century theatrical poster, hand-lettered title, painted matte |

The 6th slot is intentionally a "warm" style (`vintage_hollywood`) to balance out the 5 darker / pulpy ones — so Wholesome / Dating categories have a fitting default.

## Files touched

### Schema
- [lorewire-app/src/lib/schema.ts](lorewire-app/src/lib/schema.ts) — add `hero_style_id TEXT NULL` to `STORIES`.
- [pipeline/store.py](pipeline/store.py) — additive migration `ALTER TABLE stories ADD COLUMN IF NOT EXISTS hero_style_id TEXT`. Update SELECT lists in `fetch_story` / `upsert_story` to carry it through.

### Pipeline
- [pipeline/stages.py](pipeline/stages.py) — `HERO_STYLES` registry, `CATEGORY_STYLE_WHITELIST`, `deterministic_style_pick`, `resolve_hero_style(story_id, category, hero_style_id, get_setting)` returning a `HeroStyle`. `make_thumbnail_prompt` already takes a style band — refactor to take a `HeroStyle` so the prompt builder doesn't have to know about the resolution chain.
- [pipeline/media.py](pipeline/media.py) — `_regen_hero` and `_regen_hero_from_short` call the resolver instead of `CATEGORY_THUMBNAIL_STYLES[category]`. Log the resolved style id at every step so a "wrong style" diagnosis can read the trace.

### TS plumbing
- [lorewire-app/src/lib/stories-public.ts](lorewire-app/src/lib/stories-public.ts) — `hero_style_id` joins the `PUBLIC_COLS` projection (read-only — public reader doesn't need it but `getLiveStoryMedia` does for the picker fallback display).
- [lorewire-app/src/lib/repo.ts](lorewire-app/src/lib/repo.ts) — `StoryRow.hero_style_id: string | null`.
- [lorewire-app/src/lib/hero-styles.ts](lorewire-app/src/lib/hero-styles.ts) — **new file.** Mirror of the Python registry (same ids, same labels, thumbnail URLs only). Source of truth lives in Python; this file is a code-generated dump committed to the repo. A `pipeline/scripts/sync_hero_styles.py` writes both, so the two stay in sync (parity test in `lorewire-app/tests/lib/hero-styles-parity.test.ts`).

### Admin UI
- [lorewire-app/src/app/admin/(panel)/settings/page.tsx](lorewire-app/src/app/admin/(panel)/settings/page.tsx) — new "Visuals → Hero style" section:
  - Global default (style picker with thumbnails).
  - Per-category defaults (6 rows, one per Cat, each a picker).
  - "Generate style thumbnails" button — runs the one-time thumbnail generation if any are missing.
- [lorewire-app/src/app/admin/(panel)/stories/[id]/page.tsx](lorewire-app/src/app/admin/(panel)/stories/[id]/page.tsx) — picker on the story edit form, defaulting to the resolved style. Saving writes `stories.hero_style_id`. The existing "Restyle hero from short character" button picks up the new style automatically.
- **New shared component:** `lorewire-app/src/app/admin/(panel)/_components/HeroStylePicker.tsx` — server component, renders the 6 thumbnails as a radio-style grid with the resolved id highlighted. Used by both Settings and the story edit page.

### Story creation
- [lorewire-app/src/app/admin/(panel)/stories/new/page.tsx](lorewire-app/src/app/admin/(panel)/stories/new/page.tsx) (if exists) and any "create story from Reddit" flow — accept an optional `hero_style_id` form field. Default = NULL (let the resolver auto-pick).

### Thumbnail generation
- [pipeline/scripts/generate_hero_style_thumbnails.py](pipeline/scripts/generate_hero_style_thumbnails.py) — **new script.** For each style in `HERO_STYLES`, generate one ~3:4 sample image with a generic stock character ("a person in their 30s, neutral pose") + the style's prompt band, upload to GCS at `hero-style-thumbnails/<style_id>.png`, write the URL onto the registry entry. Idempotent — skips styles whose thumbnail URL is already populated and reachable. Triggered by the Settings page button (server action) OR by `python -m pipeline.scripts.generate_hero_style_thumbnails`.

## Settings audit (rule 15)

| Key | Type | Default | Hint copy |
|---|---|---|---|
| `hero.global_style_id` | enum (HERO_STYLES.id) or empty | empty | "Override the per-category default for every story. Empty = use per-category defaults." |
| `hero.category_default.entitled` | enum or empty | empty (→ smart auto-pick from whitelist) | "Default style for Entitled stories. Empty = smart auto-pick from a curated short-list." |
| `hero.category_default.drama` | … (same shape × 6 categories) | … | … |

Per rule 15 — every setting is a labeled control on `/admin/settings`, grouped under one "Visuals → Hero style" section, with thumbnails on each picker so the choice is obvious without docs.

## Observability (rule 14)

Every hero render logs the **resolved style id + the resolution source**:

```
[hero style resolve id=<story_id>] picked=neo_noir source=per_story
[hero style resolve id=<story_id>] picked=magazine_editorial source=category_default
[hero style resolve id=<story_id>] picked=retro_pulp source=global_default
[hero style resolve id=<story_id>] picked=comic_book source=auto_hash whitelist=['comic_book','vintage_hollywood','magazine_editorial']
```

The kie prompt log already includes the prompt body (which carries the style band) — that's enough to reverse-engineer which style ran. Adding the explicit resolution log means an admin reporting "wrong style" can paste one line and we know whether the row, category default, or auto-pick produced it.

The `[image regen hero from-short]` lines already include the safe id; we add `style=<id>` to them.

## Security (rule 13)

- **Closed-enum validation.** `hero_style_id` must be a key in `HERO_STYLES`. Server actions reject any other value with a 400. Mirrors how `narration_style_id` is validated today. Prevents a malformed value from poisoning the prompt or pointing the thumbnail at an attacker URL.
- **Settings writes are admin-only** (existing `requireAdmin` gate on `saveSettingAction`).
- **Thumbnail URLs are derived from a fixed GCS prefix** — never user-supplied. The Generate Thumbnails action computes the URL from the style id; admin never enters one.
- **No PII** on the row — `hero_style_id` is an opaque enum.

## Testing (rule 18)

### Python
- `pipeline/tests/test_hero_styles.py` — **new file:**
  - `resolve_hero_style` walks the full chain (per-story → category default → global → smart auto-pick).
  - `deterministic_style_pick` returns the same style id for the same story id across calls (idempotency).
  - `deterministic_style_pick` distributes evenly enough across a large batch (statistical sanity — no single style dominates by >2× over expected on 100 ids).
  - Every style id in every `CATEGORY_STYLE_WHITELIST` entry exists in `HERO_STYLES` (catches typos).
  - `make_thumbnail_prompt` with a resolved style uses that style's band verbatim.
- `pipeline/tests/test_stages.py::ThumbnailPromptCharacterRefTests` — extend to assert the prompt switches band when the style changes.
- `pipeline/tests/test_generate_hero_style_thumbnails.py` — the script is idempotent + skips already-uploaded thumbnails (mock gcs + images.generate).

### TypeScript
- `lorewire-app/src/lib/hero-styles.test.ts` — parity test against the Python registry (read the JSON snapshot `pipeline/data/hero_styles.json` the sync script writes, assert TS and Python see the same id set).
- `lorewire-app/src/app/admin/(panel)/_components/HeroStylePicker.test.tsx` — renders all 6 thumbnails, highlights the resolved id, fires the save action with the new id on click.
- `lorewire-app/src/lib/repo.test.ts` — `StoryRow` projection carries `hero_style_id`.

### Manual QA
- Pick a global default → publish a new story → its hero renders in that style. Per-story picker shows the global as the resolved default.
- Set a per-category default → publish a Drama story → hero renders in the per-category style, not the global.
- Leave everything empty → publish 5 Entitled stories in a row → at least 2 distinct styles appear (the auto-hash distributes).
- Change the per-category default → existing stories' heroes stay unchanged. Click "Restyle hero from short character" on one → it adopts the new default.
- Generate style thumbnails on a fresh install → all 6 appear in the picker.

## Out of scope (flagged, not done)

- **Retroactive batch regen.** No "regenerate all heroes in style X" button. Per-story is enough; if you want to bulk-update later, that becomes its own micro-feature.
- **Style preview on a real story's character.** The picker shows the generic sample thumbnail, not "your story's character in this style". Generating 6 previews per story = 6× the cost; not worth it. The admin sees the result after picking + regenerating, which is fast enough.
- **Per-aspect styles.** Portrait and landscape share one resolved style per story. (They're meant to read as the same poster series.)
- **User-editable prompt bands.** Styles are a closed enum in code. Admins can't author new styles without a deploy. Right call for MVP — opens up later if the library is too narrow.
- **Style "moods" per scene.** Could imagine a "tense" style for the climax beat — but that's a different feature about within-story variety, not catalog-wide variety. Out of scope here.

## Cost (rule 8)

- **One-time:** 6 style thumbnails × $0.04 = **~$0.24** for the initial library. Re-generated only when an admin explicitly clicks the button (e.g. to refresh the look).
- **Per restyle:** unchanged from Phase 1. 2 i2i images per `hero_from_short` regen at `kie/gpt-image-2-i2i` (~$0.04–0.08 per story). Style picker writes to the row; the existing button runs the regen with the new style.
- **No new per-render cost** for stories whose style stays the same. The resolver is a pure function over already-loaded data.

## Open questions (none blocking)

1. Should we expose the **resolution source** in the admin UI (next to the resolved style on the story edit page), e.g. "Auto-picked (from Entitled whitelist)" / "Inherited from category default" / "Pinned to this story"? Useful for debugging but adds UI clutter. Recommend: yes, as a small caption under the picker, since it makes "why does this story look like X" trivially answerable.
2. Should the **per-category whitelist** be settings-driven (admin can add/remove styles per category) or code-locked? Code-locked is simpler and prevents the "every category has all 6 styles" pathology that defeats the point. Recommend code-locked at MVP.

## Effort

- **Pipeline + TS plumbing + tests:** ~half day.
- **Admin UI (Settings section + per-story picker + thumbnail picker component):** ~half to full day.
- **Thumbnail generation script + one-time run on dev:** ~hour.
- **Manual QA + polish:** ~half day.

**Total:** 1.5–2 days of work, plus the ~$0.24 of image gen for the thumbnails.

## Sequencing

1. Schema + Python registry + resolver + tests.
2. TS plumbing (repo, stories-public, hero-styles parity).
3. Thumbnail generation script + run it once.
4. Picker component + Settings section.
5. Story edit page picker.
6. Manual QA pass + commit + PR.

Each step is independently shippable — no big-bang merge.
