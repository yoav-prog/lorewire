# Browse pagination — lift the 200/201-title ceiling

Date: 2026-07-14
Status: approved (user chose option B), implementing.

## Problem

The desktop Browse page shows "ALL TRUE STORIES · 201 TITLES" and never grows,
even as more stories are produced. Root cause: `loadLiveCatalog(limit = 200)`
(`src/lib/homepage-data.ts`) caps the live catalog query at `LIMIT 200`. The
whole homepage — rails, hero, Browse, Search, New — reads one shared in-memory
`catalog.array` built from those 200 rows plus static sample `STORIES`. Browse
renders `catalog.array.filter(isPublishedStory)`, so it can never exceed the cap.
The `201` is the 200 newest live rows plus one static sample that passes the
published gate.

Verified against production Neon Postgres on 2026-07-14:
- 224 stories total (218 published, 6 in review)
- 218 Browse-eligible (exact `loadLiveCatalog` WHERE gate)
- 0 missing slug, 0 noindexed
- So **18 published stories are silently invisible on Browse right now**, and the
  gap grows with every new story past 200.

Category distribution sums to exactly 218 (Family Feuds 32, Neighbor Wars 20,
Dating Disasters 20, Creepy 19, ... Bad Bosses 1), confirming the eligible set.

## Goal

Browse shows the full catalog and scales without a ceiling, via cursor
pagination + infinite scroll — the same pattern the Wires feed already uses
(`listPublishedShorts` + `useWiresData`). Correct, not a raised magic number.

## Constraints

- Dual DB driver (Postgres in prod, node:sqlite in tests/local). Portable SQL only.
- Must preserve existing behavior: same public gate, same category-chip filter
  semantics (exact match on `stories.category`), same modal-open flow.
- A story paged in beyond the shared 200-window catalog MUST still open its
  detail modal — the shell resolves the clicked id via `resolveStory`, which
  only knows the shared catalog + static STORIES.

## Chosen approach (B)

### Architecture / layers (SSOT + boundaries, rule 20)

- **Data (server, testable lib):** `loadBrowsePage(opts)` in
  `src/lib/homepage-data.ts`, next to `loadLiveCatalog`, sharing one extracted
  projection helper `projectCatalogRows(rows)` (duration self-heal + media-URL
  resolve, rebuilt field-by-field so no private column leaks). This is the
  single source of the catalog projection; `loadLiveCatalog` is refactored to
  use the same helper (its duration tests guard the refactor).
- **Action boundary:** thin `"use server"` `listBrowseStories(opts)` in
  `src/app/actions.ts` delegates to `loadBrowsePage`, mirroring how
  `getLiveCatalog` wraps `loadLiveCatalog`.
- **Client data:** `useBrowseData(pageSize, categories)` hook in
  `src/components/browse/useBrowseData.ts`, mirroring `useWiresData`: first page
  (with total) on mount / filter change, `loadMore` appends by cursor with
  id-dedupe.
- **Presentation:** desktop `BrowsePage` renders its own paginated grid + an
  `IntersectionObserver` sentinel that calls `loadMore`. Category chips
  (`useCategoryFilter`) drive the server-side filter. Header shows the true
  total from the count query.

### Keyset (compound) cursor — correctness

Order is `COALESCE(published_at, updated_at, created_at) DESC, id DESC`. Cursor
is `"<coalesced_ts>|<id>"`. Next-page predicate:
`(coalesced < ? OR (coalesced = ? AND id < ?))`. Guarantees no skipped or
duplicated rows even when several stories share a timestamp (stricter than the
Wires single-key cursor, which Browse can't tolerate since it must show all).

### Opening a paged-in story (resolveStory gap)

`BrowsePage` reports its loaded `Story[]` up to the shell via an
`onStoriesLoaded` callback. The shell keeps a `browseAdditions` map and resolves
the modal id as `resolveStory(id) ?? browseAdditions.get(id)`. Slide prev/next
resolves through the same fallback. "More Like This" keeps using the shared
catalog (only needs 6 suggestions) — acceptable.

## Alternatives rejected

- **A. Raise the cap (default 200 → 1000, lift `Math.min` 500 ceiling).** One-line
  unblock, but keeps "load the entire catalog into the client on every page
  load" and still has a hard ceiling. The user explicitly chose B.
- **Two-tier catalog refactor (rails get a small window, Browse/Search/New a
  paginated source).** Correct end-state but a much larger blast radius touching
  every homepage surface. Deferred; this change is the first slice of it.

## Scope

- IN: desktop `BrowsePage` (the reported surface) fully paginated.
- OUT (flagged, follow-up): desktop `SearchPage`, mobile `Search` + `NewScreen`,
  and the shared homepage catalog still read the 200-capped in-memory catalog.
  Rails/hero/More-Like-This only need a handful, so they are unaffected in
  practice; Search/New sharing the cap is a real but separate gap.

## Security (rule 13)

- Public, unauthenticated read path — same gate as `loadLiveCatalog` /
  `listPublishedShorts` (`status IN ('ready','published') AND slug IS NOT NULL
  AND noindex off`). No new surface, no PII, no auth change.
- Category values are bound as SQL parameters (`IN (?, ?)`), never interpolated.
  Cursor is split and bound as params; malformed cursor → treated as no cursor
  (first page), never an error path that leaks.
- Page size clamped 1..100 so a crafted `limit` can't ask for the whole table.

## Observability (rule 14)

- `console.info("[browse page load]", { limit, categories, hasCursor, count, hasMore, total })`
  server-side per page.
- `console.info("[browse render]", { loaded, total, categories, reachedEnd })` and
  `[browse loadMore]` / `[browse load err]` client-side (keeps the existing
  `[browse render]` namespace).

## Settings (rule 15)

- No new user-facing setting. Page size is an internal constant, not a
  preference (a lazy user does not tune page size). Intentionally not exposed.

## Testing (rule 18)

`src/lib/browse-page.test.ts` (seeds the test SQLite like the duration tests):
- pages: >pageSize rows → first page has `nextCursor` + correct `total`; last
  page → `nextCursor` null. Fails on old code (no `loadBrowsePage`).
- compound cursor: rows sharing one timestamp are neither skipped nor duplicated
  across the page boundary (the regression this design prevents).
- category filter: `categories` restricts rows AND `total` reflects the filter.
- gate: excludes `status='review'`, null slug, `noindex=1`.
Run the affected suite (`homepage-data`, `browse-page`, duration) green before done.

## Deploy (rule 19)

- Branch off fresh `main` (current branch is `chore/ads-txt-adsense`; do NOT
  build on it). New branch `feat/browse-pagination`.
- PR into `main`. No schema/migration/env change. Standard pipeline deploy on
  merge. Nothing promoted manually in Vercel. Confirm Vercel Production Branch
  state at deploy time per AGENTS.md.

## Open questions

- Extend the same pattern to Search + mobile New next? (Flag to user after this
  ships.)
