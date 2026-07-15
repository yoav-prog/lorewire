# Too-long title filter + bulk regenerate in the Content admin

## The ask

Stories sometimes carry titles that are too long, which makes the title
render weird on the cover image. Three parts:

1. Limit the number of words a title can have.
2. Filter the admin Content page to the stories whose title is too long.
3. Select those and regenerate a proper (short) title in bulk.

## What already exists (verified 2026-07-15)

The 2026-06-25 title length gate (`_plans/2026-06-25-title-length-gate.md`)
already built most of part 1:

- **Generator** (`pipeline/stages.py:1206`): hard cap `TITLE_MAX_CHARS = 50`
  / `TITLE_MAX_WORDS = 8`, with a retry and a deterministic salvage so the
  pipeline never ships a too-long title.
- **Render floor** (`lib/hero-title-size.ts`): the hero font shrinks by
  length so an over-long title can't blow up the cover.
- **Single-story fix** (`lib/title-regenerator.ts` +
  `regenerateStoryTitleAction`): a "Regenerate title" button on the
  individual short editor (`StoryTitleHeader.tsx`), one story at a time.

So the word limit is already enforced at generation time. The real gap:

- **The DB still holds too-long titles.** The gate only started guarding on
  2026-06-25, so pre-gate stories keep their long titles. The
  user-submission path (`submission-promote.ts:82` → `createStory`) writes
  the submitted title raw with **no gate at all**, so it is an ongoing
  bypass. There is no way to find these rows or fix them in bulk.

## Decisions (from the user, 2026-07-15)

- **"Too long" = over 8 words OR over 50 chars.** Keep today's enforced cap
  as the definition — the filter surfaces exactly the titles that violate
  current policy (legacy + bypassed + any slip-through). No change to the
  generation cap value (it is already 8/50).
- **One shared constant drives generation, the filter, and the fix.** The
  8/50 numbers become a single source of truth the whole app reads.

## Chosen approach

### 1. Centralize the policy — `lib/title-policy.ts` (new)

A tiny, dependency-free module (no `server-only`, no repo import — so
`repo.ts` can import it without a cycle):

- `TITLE_MAX_CHARS = 50`, `TITLE_MAX_WORDS = 8`.
- `titleWordCount(title)` — `trim().split(/\s+/).filter(Boolean).length`.
- `isTitleTooLong(title)` — null/blank → false; else chars > MAX || words > MAX.

`title-regenerator.ts` imports the two constants from here (and re-exports
them for its existing importers) instead of defining its own, so the
generator-mirror and the filter can never drift.

### 2. Filter — `ContentPageOpts.titleLength?: "long"`

- `buildContentTableWhere` (stories branch): when `titleLength === "long"`,
  push a portable SQL predicate (SQLite + Postgres):
  `(title IS NOT NULL AND (LENGTH(title) > 50 OR
   (LENGTH(TRIM(title)) - LENGTH(REPLACE(TRIM(title),' ','')) + 1) > 8))`.
  The word count is spaces+1 — exact for the single-spaced ALL-CAPS titles
  the app produces. Thresholds interpolated from the `title-policy`
  constants (module numbers, not user input — no injection).
- `contentPageWants`: `titleLength === "long"` drops the article half
  (stories-only, matching category/flagged/job/active). Both the pager and
  the select-all-matching resolver read this, so the filter works in both.
- `page.tsx`: new `titleLen` URL param → `pageOpts.titleLength`; a "Title"
  chip row (`All | Too long`) with the hint "(video stories only · over 8
  words / 50 chars)"; an active-filter chip; threaded through `baseQs`.

### 3. Bulk fix — `bulkRegenerateTitlesAction` (new)

Mirrors `bulkReclassifyContentAction` exactly (the closest precedent: a
per-story synchronous LLM operation with a clean per-row result), NOT the
async-enqueue `bulkRegenerateContentAction` (whose "queued N" banner would
misreport a synchronous rewrite):

- `requireCapability("content.manage")`, `validateItems(items,
  MAX_BULK_PAID_ITEMS)` (cap 50 — it spends on the LLM), audit.
- Loop: article → `skipped` ("not-a-story"); story →
  `regenerateTitleForStory(id)`. Map `ok:true` → `regenerated`
  (prev/next title); `ok:false` stage `story-missing-body` → `skipped`;
  any other failure → `failed` (reason). `revalidatePath("/admin/content")`.
- Result: `{ regeneratedCount, skippedCount, erroredCount, outcomes }`.

Client (`ContentList`): a visible **"Regenerate titles"** `BarButton` next
to "Reclassify AI" (its AI-fixer sibling — most discoverable for the
filter → select-all → fix flow), a `TitleRegenConfirmModal`, and a
`TitleRegenResultBanner` ("Regenerated N · skipped M (no body) · failed K",
first few old→new). Stories-only; disabled when the selection has no story.

Timeout note: 50 × gpt-5-nano-minimal (~1-2s each) ≈ 50-100s in one action.
Confirm `maxDuration` during implementation; if the default is too low,
either lower the per-action cap or batch client-side like the regen flow.

## Alternatives rejected

1. **Add "title" to the existing `BulkRegenTarget` menu.** The regen path
   enqueues async render jobs and shows a "queued" banner; a synchronous
   title rewrite would misreport, and 50 inline LLM calls don't belong in
   an enqueue loop. Reclassify is the right precedent.
2. **Truncate long titles at render time.** Cuts mid-word and leaves the
   bad title in the DB (search / share / SEO still carry it). Already
   rejected in the 2026-06-25 plan.
3. **Include articles in the filter.** Article titles are hand-authored
   (not a pipeline mistake) and can't be auto-fixed by the story
   regenerator. Surfacing them would be dishonest — everything the filter
   shows should be fixable.
4. **Lower the generation cap below 8/50.** User chose to keep 8/50; a
   tighter cap would reclassify many currently-legal titles as "too long".

## Security & safety (rule 13)

- Both the filter query and the bulk action are gated by
  `requireCapability("content.manage")` — same gate every content-write
  uses. The bulk action audits via `auditBulkContent`.
- No user input reaches the SQL thresholds (module constants) or the LLM
  prompt (body is admin-authored `stories.body`; category is a closed set).
- `regenerateTitleForStory` never throws and never writes on failure — no
  partial state. The paid cap (50) bounds spend per click.

## Observability (rule 14)

- Reuse the existing `[title regen ...]` logs in `title-regenerator.ts`.
- New: `[content bulk title-regen] start/done` with counts, matching the
  other bulk actions' log shape.

## Testing (rule 18)

- `lib/title-policy.test.ts`: `isTitleTooLong` / `titleWordCount` at the
  50-char and 8-word boundaries; null/blank → false.
- Extend the content-page data test: `titleLength: "long"` returns only
  over-cap stories and no articles.
- Action test: `bulkRegenerateTitlesAction` maps regenerated / skipped
  (no body) / failed with a mocked `regenerateTitleForStory`.
- Manual QA: seed/verify a too-long story, filter to "Too long", select
  all, Regenerate titles, confirm titles shorten and the row leaves the
  filtered view; confirm articles never appear under the filter.

## Deploy (rule 19)

Additive: one new lib module, one new server action, filter plumbing, UI.
No schema change, no Python change. Revert removes them cleanly. Branch is
the current `feat/content-filters-select-all`; PR targets `main`. Check
Vercel Environments → Production state before any merge (AGENTS.md).

## Open questions — resolved during implementation

- `maxDuration` for the bulk action route: no config change needed.
  `bulkReclassifyContentAction` already runs synchronous per-story LLM calls
  from the same `/admin/content` page at up to a 200-item cap with no
  `maxDuration` override and ships fine; title regen at the 50 paid cap
  (cheaper, faster gpt-5-nano-minimal) is strictly safer. Kept the paid-op
  pattern (cap 50, block over) that Complete / Refresh / Full-pipeline use.
- Generator cap: user chose to keep 8 words / 50 chars, so `pipeline/stages.py`
  is unchanged. The constants were centralized in `lib/title-policy.ts` so the
  filter and fix read the same numbers as the generator mirror.

## Verification

- `lib/title-policy.test.ts`, the `titleLength` case in the content-page data
  test, and the `bulkRegenerateTitlesAction` action tests all pass (80/80 in
  the four affected suites). Typecheck + lint clean on every changed file.
  Remaining step for the user: a live click-through in the running admin.
