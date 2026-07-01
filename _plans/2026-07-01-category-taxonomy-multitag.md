# Category re-architecture: data-driven, multi-tag taxonomy

**Date:** 2026-07-01
**Status:** Approved in principle by Yoav (four locked product picks + two follow-up picks). Implementation phasing below still to be green-lit PR by PR.
**Surfaces:** `stories.category` + denormalized copies (polls/votes/aggregates/favorites), the two LLM classifiers (Python pipeline + TS admin), homepage rails + pill filter, `/c/[surface]` landing pages, admin `/content` + `/voiceovers`, CSS color tokens, and the six code locations that duplicate the category list.
**Council:** Verdict synthesized 2026-07-01 (5 advisors + 5 anonymized peer reviews). Key rulings folded in below.

---

## Problem (verified in code)

Today a story's `category` is ONE value doing six jobs, hardcoded as a closed six-item enum (`Drama, Entitled, Humor, Wholesome, Dating, Roommate`) that must stay in lockstep across **six** source-of-truth locations:

1. `Cat` union type - [stories.ts:6](../lorewire-app/src/lib/stories.ts#L6) (+ `CAT` hex map at [:49](../lorewire-app/src/lib/stories.ts#L49))
2. `CATEGORIES` array - [admin/ui.ts:3](../lorewire-app/src/app/admin/ui.ts#L3)
3. Python `STORY_CATEGORIES` tuple + `SUBREDDIT_CATEGORY` map - [stages.py:53](../pipeline/stages.py#L53)
4. `CATEGORY_RAILS` + `GLYPH_BY_CAT` + `AUGMENTING_SURFACES` - [homepage-rails.ts:135](../lorewire-app/src/lib/homepage-rails.ts#L135)
5. Six `--color-cat-*` CSS tokens - [globals.css:16](../lorewire-app/src/app/globals.css#L16) - referenced as **static** Tailwind classes (`bg-cat-drama`) across ~32 files
6. Validation `STORY_CATEGORIES` Set - [admin/actions.ts:3404](../lorewire-app/src/app/admin/actions.ts#L3404)

`stories.category` is plain `TEXT` with no constraint, denormalized (also `TEXT`, no FK) onto `polls`, `poll_votes`, `poll_aggregates`, `user_fav_categories`. Two LLM classifiers build a prompt from the list and validate output: [stages.py:81](../pipeline/stages.py#L81) `classify_category` (Python) and [category-classifier.ts](../lorewire-app/src/lib/category-classifier.ts) (TS). `HOMEPAGE_SURFACES` bakes the six category rails into a fixed 10-surface enum ([homepage-curation-shared.ts:12](../lorewire-app/src/lib/homepage-curation-shared.ts#L12)); a daily-rotating slot cycles the six. A `/c/[surface]` landing page route exists.

**The owner's complaint:** "Drama" is a junk drawer. ~90% of stories are Drama because three fallbacks compound to it. We need many more specific categories, for existing and new stories.

**The real architectural flaw (why "just add more" is wrong):** the single `category` field couples *navigation* (rails, colors, glyphs) to *description* (what the story is about). So every new category is forced to earn a color, a glyph, and a homepage row, and each addition is a code change across six files + a deploy. That coupling, not the count, is the problem.

---

## Locked decisions (do not relitigate)

From two rounds of scoping + the council:

1. **Admin-managed in DB.** Categories become rows in a `categories` table with admin CRUD (label, color, glyph, rail flag). Adding one later is an admin task, not a deploy.
2. **Retire "Drama."** Every current Drama / uncategorized story gets reclassified into specific categories. No story stays generically "Drama."
3. **Decouple browse.** A few homepage rails (hand-picked color) + a larger specific tag set powering tagging / filtering / SEO / `/c/` landing pages / browse-all. Rail-worthy categories get a curated color; the rest get an auto-assigned palette slot.
4. **Seed ~18 granular categories, cleaned up.** Multi-tag lets overlapping tags coexist, so we keep granularity but resolve true duplicates and jargon (see taxonomy below).
5. **Multi-tag with one primary.** Schema is many-to-many from the start (`story_tags` join). Each story gets 1-3 tags, exactly one marked **primary**. The primary drives the card color/glyph and the poll/favorite denormalization, so nothing downstream breaks. This was the council's near-unanimous ruling: for this genre "cheating-at-a-wedding-over-the-inheritance" is the *median* story, single-tag is a classifier coin-flip, and the retire-Drama reclassification is the one cheap moment to multi-tag 90% of the library.

---

## Chosen architecture

### Two objects, not one (First Principles ruling)

- **Tags** = what a story is about. Many-per-story. The classifier's job. Drives filtering, SEO, `/c/` pages, favorites, browse-all.
- **Rails** = editorial homepage surfaces. A curated few. Presentation, not truth. **A rail is a saved query over tags**, not a "big category" (e.g. a "Family Chaos" rail = `family-feuds OR in-laws OR wedding-drama`).

### Source of truth + denormalization

- **`story_tags` is the source of truth** for a story's tags.
- **`stories.category`** (existing column) becomes a denormalized cache of the **primary** tag's *slug*, kept in sync on every primary change. Every existing read site (homepage rails, pill filter, poll denormalization) keeps working against it during the transition - this is what makes "one primary drives denormalization so nothing downstream breaks" true.
- **Slug is the join key everywhere. Labels are display-only.** `story_tags.category_slug`, the denormalized copies, and all joins reference the immutable slug (e.g. `cheating-betrayal`), never the human label. A label rename then touches zero denormalized rows - this neutralizes the Contrarian's sharpest footgun ("a TEXT-label rename button is a data-corruption button with a nice UI").

### New schema (added to `schema.ts` `TABLES`; additive auto-migrate applies it)

`categories`:
| column | type | notes |
|---|---|---|
| `slug` | TEXT PK | immutable key, e.g. `cheating-betrayal` |
| `label` | TEXT | display, editable |
| `glyph` | TEXT | card symbol |
| `color` | TEXT | hex; NULL = auto-assign from palette |
| `is_rail` | INTEGER | 1 = homepage rail + curated color |
| `rail_title` | TEXT | rail header when `is_rail` |
| `sort` | INTEGER | ordering |
| `status` | TEXT | `active` \| `archived` (soft-delete; never hard-delete a category with rows) |
| `description` | TEXT | SEO landing copy + classifier hint |
| `created_at` / `updated_at` | TEXT | |

`story_tags`:
| column | type | notes |
|---|---|---|
| `story_id` | TEXT | |
| `category_slug` | TEXT | references `categories.slug` |
| `is_primary` | INTEGER | exactly one =1 per story |
| `source` | TEXT | `llm` \| `admin` \| `subreddit` \| `migration` |
| `confidence` | REAL | classifier confidence, nullable |
| `created_at` | TEXT | |

Indexes: PK `(story_id, category_slug)`; `idx_story_tags_category` on `category_slug`; partial unique `(story_id) WHERE is_primary = 1`.

### The classifier (one brain)

Two prompts against a mutable admin-editable list is a guaranteed split brain (Contrarian), and the two classifiers already disagree on *existing* stories, so a naive "delete one" silently re-tags live data at cutover (peer review). Resolution:

- **Both runtimes read the same manifest** for the category *set* - they cannot drift on which categories exist.
- **Python pipeline owns classification at creation.** It returns 1-3 tags + confidence + designates primary.
- **The TS admin path stops re-implementing classification.** Preferred end state: the admin "reclassify" action enqueues a job the Python worker processes (one brain). Acceptable phase-1: TS calls a shared prompt template + pinned model from the manifest so the two callers share one spec. Final call at implementation time; either way the *spec* is single-sourced.
- **Cutover reconciliation:** before retiring the TS classifier, run a diff pass over already-classified stories and log disagreements; don't blind-overwrite.

### Colors under runtime categories (Tailwind trap)

Static `bg-cat-<slug>` classes are purged at build and cannot exist for admin-created slugs; a safelist is a trap past ~18. **New/runtime categories deliver color via inline `style` / CSS custom properties keyed by slug** (the existing `CAT` hex map is already this pattern). The six legacy `--color-cat-*` tokens stay for the rail-worthy categories that keep curated colors; everything else resolves a color from the `categories.color` row (or an auto-assigned palette slot when NULL).

---

## Cleaned taxonomy (seed set)

Under multi-tag, overlap is a feature (a story gets both), so we keep granularity and only resolve **true duplicates / cold-visitor jargon** the Outsider flagged. Proposed seed (17), with rail flags:

| # | Label | slug | Rail? | Notes |
|---|---|---|---|---|
| 1 | Entitled People | `entitled-people` | ● rail | absorbs "Karens" as a flavor |
| 2 | Public Freakouts | `public-freakouts` | | was "Karens & Freakouts" - re-scoped to public meltdowns so it is not a synonym for Entitled |
| 3 | Family Feuds | `family-feuds` | ● rail | was "Toxic Family" - scoped to blood family |
| 4 | In-Laws from Hell | `in-laws` | | kept distinct (huge JUSTNOMIL niche) |
| 5 | Cheating & Betrayal | `cheating-betrayal` | ● rail | |
| 6 | Wedding Drama | `wedding-drama` | ● rail | |
| 7 | Money & Inheritance | `money-inheritance` | | |
| 8 | Workplace Nightmares | `workplace` | ● rail | |
| 9 | Bad Bosses | `bad-bosses` | | subset of Workplace; multi-tag lets a story hold both |
| 10 | Neighbor Wars | `neighbor-wars` | | |
| 11 | Roommate Hell | `roommate-hell` | | |
| 12 | Dating Disasters | `dating-disasters` | ● rail | |
| 13 | Breakups | `breakups` | | during-vs-after distinction from Dating |
| 14 | Friendship Fallouts | `friendship-fallouts` | | |
| 15 | Revenge & Karma | `revenge-karma` | ● rail | merged "Sweet Revenge" + "Instant Karma" (indistinguishable to browsers) |
| 16 | Malicious Compliance | `malicious-compliance` | | kept - the target audience knows the term (r/MaliciousCompliance) even if a cold normie does not; distinct mechanic |
| 17 | Wholesome Wins | `wholesome-wins` | ● rail | |

8 rails, 9 tag-only. Rails + the existing daily-rotating slot (which will now cycle a wider pool including non-rail tags) keep the homepage from becoming a wall of rows. **All names + rail flags are admin-editable after seed; this is a starting point, not a commitment.** Yoav to approve final labels before PR1 seeds them (slugs are then immutable forever).

---

## Phased build (ship value early, isolate DB risk)

**PR1 - Single manifest, collapse the duplicated lists. (No DB, no behavior change.) [BUILT]**
- New `src/lib/categories/manifest.ts` holds the CURRENT six categories in the rich shape (`slug, label, glyph, color, railSurface, railTitle, subreddits[]`) and derives `Cat`, `CAT_COLORS`, `CATEGORY_GLYPHS`, `CATEGORY_RAIL_ENTRIES`, `SUBREDDIT_CATEGORY`, `isCategoryLabel`. The `Cat` union is preserved from the manifest (no `string` widening); Zod was skipped in favor of the codebase's existing type-guard idiom.
- The 17 new categories are NOT introduced here - they land in PR3 with the classifier + reclassification so existing stories (all still on the old values) are not stranded and no empty new rails appear. PR2 stands up the DB tables and seeds today's six; the granular set + slug-freeze happen in PR3.
- Category-list consumers now derive from the manifest: `stories.ts` (Cat/CAT), `admin/ui.ts` (CATEGORIES), `homepage-rails.ts` (CATEGORY_RAILS + glyphs), `admin/actions.ts` (bulk-op validation set), plus the admin surfaces `templates/page.tsx` (CATEGORIES), `settings/page.tsx` (rotating-rail dropdown + shorts list) and `settings/socials/page.tsx` (shorts list).
- Two copies the manifest can't import at build time are guarded by `manifest.test.ts` against drift: `pipeline/stages.py` (STORY_CATEGORIES + SUBREDDIT_CATEGORY, separate runtime) and the `--color-cat-*` tokens in `globals.css` (static Tailwind).
- **Intentionally out of scope for PR1 (own registry / follow-up):** the per-category hero-style defaults (`HERO_CATEGORY_KEYS` in `settings/page.tsx`, keyed to the Python hero resolver) and the hero-style whitelist (`hero-styles.json` / `CATEGORY_STYLE_WHITELIST` / `hero-styles.test.ts`) are a separate Python-owned registry with its own `sync_hero_styles` + `test_hero_styles_sync` parity mechanism. They will need to grow with the taxonomy in PR2+, but folding them into PR1 would entangle the hero-style subsystem.

**PR2 - DB tables + seed + backfill + data layer. (No behavior change.) [BUILT]**
- Added `categories` + `story_tags` to `schema.ts` (composite-unique `(story_id, category_slug)` + partial-unique `(story_id) WHERE is_primary=1` one-primary-per-story; story_tags has no single PK since createTableSql supports only one).
- `seedCategories` + `backfillStoryPrimaryTags` in the db.ts schema chain: idempotent + self-healing (seed = ON CONFLICT DO NOTHING from the manifest; backfill joins `stories.category = categories.label` -> slug, skips already-primary + unmatched + null). Public wrappers exported for manual re-runs + tests.
- Server-only read layer `lib/categories/repo.ts` (listCategories / getCategoryBySlug / getStoryTags / getPrimaryTag). Integration tests cover seed idempotency + backfill mapping / skip / one-primary invariants.
- Seeds TODAY'S SIX (all rails), not the 17 - those + the classifier + reclassification are PR3. `stories.category` is untouched (stays the label the current read paths use); story_tags is the new slug source, `categories` bridges label<->slug. story_tags is populated but NOT yet on any read path (PR3 wires reads).
- DEFERRED: the read-only admin PAGE (throwaway before PR4 CRUD) and the `pipeline/store.py` Python seed mirror (PR3, when the classifier reads categories). No TS<->Python full-schema parity test exists, so schema.ts-only is fine.

**PR3 - Multi-tag classifier + the retire-Drama reclassification (the risky, irreversible step - gated).**
- Python classifier returns 1-3 tags + confidence + primary, validated against the manifest.
- Reclassification job over Drama/uncategorized stories: **dry-run first**, writes to `story_tags` (not a blind overwrite of `category`), keeps the prior value one release for rollback, idempotent (safe to re-run), and skips stories under a **confidence floor** into an admin **review queue** rather than guessing. Human spot-check a sample against an accuracy target before the batch is allowed to touch the primary cache.

**PR4 - Admin CRUD.**
- Create / rename (label only; slug frozen) / recolor / archive / set-rail / reorder. Merge/alias flow to fight sprawl (Reviewer 4). Archive, never hard-delete, when a category has rows.

**PR5 - Homepage decouple + browse + SEO.**
- Rails read `is_rail` rows (not the hardcoded count of 6); rotating slot pulls from the wider pool.
- Pill filter + browse-all + `/c/[slug]` landing pages read the full tag set and `story_tags`.
- **301 redirects** from dead `Drama` / old `/c/*` URLs to their new homes (Reviewer 3) - no 404s, no lost SEO.
- Optional later: intersection landing pages (`/c/cheating-betrayal+wedding-drama`) as long-tail SEO - schema already supports it (Expansionist). Not built now; the join table leaves room.

---

## Alternatives rejected (and why)

- **Single-tag (keep today's model).** Rejected by the council near-unanimously: forces classifier coin-flips on the plurality of the corpus, and defers a second migration through five denormalized tables. The one cheap multi-tag window is the reclassification we are already doing.
- **Big-bang (full data-driven + CRUD + multi-tag in one PR).** Rejected: bundles the reversible cheap win (manifest collapse) with the irreversible risky step (reclassifying live production data). Phasing isolates the risk.
- **Keep both classifiers as-is.** Rejected: split brain against a now-*mutable* list; they already disagree on existing stories.
- **Expand the hardcoded enum only (no table).** Rejected earlier by the owner; also doesn't honor admin-managed and keeps the color/glyph/rail-per-category coupling.
- **Hierarchy / tag weights / playlist mapping / analytics-on-tags now.** Deferred (Expansionist upside). The many-to-many schema and a `description`/`confidence` column leave room; we don't build them in this arc.

---

## Security (rule 13)

- All new admin actions begin with `requireAdmin()`; no new public auth surface.
- Classifier prompt is built from admin-owned story title + body only; no untrusted user input enters it. LLM output is matched against the closed manifest set **before** any write, so a model returning `DROP TABLE` never becomes a tag.
- Slug is validated `^[a-z0-9-]+$` on create; labels are escaped at render. No SQL built from labels.
- Reclassification is capped per call (mirror existing `MAX_BULK_ITEMS`) so a runaway can't issue thousands of LLM calls.
- Soft-delete (archive) prevents an admin from silently orphaning historical poll/favorite rows.
- No body text logged - only ids + slug transitions, matching the existing bulk-action logging contract.

## Cost (rule 8)

Reuses the already-integrated, already-paid LLM path (`gpt-5-nano`). Reclassifying the backlog at ~2k tokens/story is fractions of a cent per story - the whole library is dollars, not a new line item. No new paid service, host, or subscription. I'll drop the actual token count into the PR3 description before the batch runs.

## Observability (rule 14)

- Reclassify: `[reclassify start/item/done]` with counts, `prev`/`next` slugs, confidence, and review-queue routing.
- Classifier disagreement diff logged at cutover.
- Rail resolution + rotating-slot pick logged (extends existing `[lorewire curation ...]` lines).
- Redirect hits logged so dead-URL volume is visible post-cutover.

## Testing (rule 18)

- Manifest parity test (TS list == Python list == seeded `categories` rows).
- Classifier: valid multi-tag, garbage → fallback, low-confidence → review queue, exactly-one-primary invariant.
- `story_tags` invariants: one primary per story; slug FK validity; archive doesn't orphan.
- Rail resolution off `is_rail`; pill filter against `story_tags`; redirect map.
- Reclassification: dry-run produces no writes; idempotent re-run is a no-op; rollback restores prior primary.

## Open questions

1. Final labels + which are rails (Yoav approves before PR1 freezes slugs).
2. i18n: categories are English-only today; LoreWire runs EN+HE elsewhere. Slug-as-key already survives translation, but do we need Hebrew display labels now or later? (Leaning later; schema leaves room via a future `label_he` column.)
3. Classifier: enqueue-to-Python (one brain, more plumbing) vs shared-spec-two-callers (less infra) for PR3 - decide when we get there.
4. Confidence floor value + spot-check accuracy target for the reclassification gate.

## Process notes

- Per rule 9, consult Context7 for Next.js 16 + the Postgres/SQLite driver before writing PR code; per AGENTS.md, read `node_modules/next/dist/docs/` for anything framework-touching (this Next.js has breaking changes).
- Per AGENTS.md git rules: main = production as of 2026-07-01. This work branches off fresh `main` (not the current `fix/hook-tail-hold-dynamic` branch), one concept per commit, fetch + divergence-check before any push.
