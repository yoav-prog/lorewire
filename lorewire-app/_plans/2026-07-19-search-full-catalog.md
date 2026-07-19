# Search pages the full catalog (mobile Search + desktop SearchPage)

Date: 2026-07-19. Branch: `feat/search-full-catalog` off `origin/main @ 5fba547`.

## Problem

Yoav reports the mobile Search page header reads "Browse all - 201 stories"
while production has far more. This is the follow-up explicitly flagged and
scoped OUT of _plans/2026-07-14-browse-pagination.md (PR #250): that change
paginated desktop Browse only, while desktop `SearchPage` and mobile `Search`
kept rendering `catalog.array` — the shared in-memory homepage catalog that
`loadLiveCatalog` caps at 200 live rows. Mobile has no separate Browse tab, so
Search IS the catalog browser there, which makes the cap most visible on
mobile. Text search has the same ceiling: a story beyond the 200-row window can
never be found.

`NewScreen` / "Today's Verdicts" also read the capped catalog but only ever
show the 10 freshest stories, which the 200-row recency window always
contains. No user-visible gap; left out of scope again.

## Goal

Mobile Search and desktop SearchPage list and search the WHOLE published
catalog with no ceiling, reusing the exact machinery PR #250 built (keyset
cursor + infinite scroll), with the text query pushed down as a server-side
WHERE so matches beyond any client window are found.

## Approach (chosen)

Extend, don't fork:

1. `loadBrowsePage` (src/lib/homepage-data.ts) gains `query?: string` — a
   case-insensitive substring match on `title` OR `category`, wildcards
   escaped, bound as SQL params. `total` respects the query so the header
   count is honest. Same SQL runs on SQLite + Postgres (`LOWER`/`LIKE`/
   `ESCAPE` are portable; the db layer translates placeholders).
2. `useBrowseData` gains a third `query` param (default `""`, so the existing
   desktop Browse callsite is untouched). Two small hooks join it in
   src/components/browse/useBrowseData.ts: `useDebouncedValue` (search box →
   250 ms settle before a round trip) and `useLoadMoreSentinel` (the
   IntersectionObserver block lifted verbatim out of desktop BrowsePage so all
   three grids share one copy).
3. Mobile `Search` (AppShell) renders from the pager instead of
   `catalog.array`: chips drive the server-side category filter, the query
   drives the server-side text filter, an end-of-grid sentinel appends pages.
   Loaded rows are lifted to the shell (same `onStoriesLoaded` pattern as
   desktop Browse) so tapping a story beyond the rails' 200-row window still
   opens the TitleSheet.
4. Desktop `SearchPage` gets the identical treatment (query from the header
   box, no chips, lifts rows into the existing additions map, which is renamed
   since it is no longer Browse-only).

## Alternatives rejected

- **Raise the 200 cap.** Same rejection as in the Browse plan: still a
  ceiling, still ships the whole catalog to every client. Yoav already chose
  pagination over cap-raising for Browse.
- **Client-side search over progressively loaded pages.** Keeps search
  instant per keystroke but a query only searches what happens to be loaded —
  a user searching "package" would silently miss stories on unfetched pages.
  Server-side WHERE searches everything, and 250 ms debounce keeps the
  round-trip cost sane.
- **A dedicated search endpoint (FTS).** Real full-text search (ranking,
  typo tolerance) is a bigger product decision with schema implications
  (SQLite FTS5 vs Postgres tsvector diverge). The current bar is substring
  match; LIKE meets it with zero schema change. Revisit if search quality
  becomes a complaint.

## Scope

- IN: `loadBrowsePage` query support + tests; `useBrowseData` query param;
  shared debounce + sentinel hooks; mobile `Search`; desktop `SearchPage`;
  desktop `BrowsePage` refactored onto the shared sentinel hook.
- OUT: `NewScreen` / "Today's Verdicts" (top-10 only, unaffected in
  practice); sample-catalog stories not present in the DB no longer appear in
  Search results (Browse already made that call — the DB is the catalog);
  FTS-quality search.

## Security (rule 13)

- Same public unauthenticated read path and gate as PR #250. The query is
  bound as a SQL parameter, never interpolated; `%`, `_`, `\` in user input
  are escaped so a crafted query can't wildcard-scan or error. Page size
  clamp (1..100) unchanged.

## Observability (rule 14)

- Server: `[browse page load]` gains the `query` field.
- Client: `[search render]` (`{ shell, query, categories, loaded, total }`)
  on both shells, mirroring `[browse render]`.

## Settings (rule 15)

- No new user-facing setting. Debounce interval and page size are internal
  constants, not lazy-user knobs. Intentionally not exposed.

## Testing (rule 18)

Extend src/lib/browse-page.test.ts (fails on old code — no `query` opt):
- title + category matches, case-insensitive, `total` respects the query;
- LIKE wildcards (`%`, `_`) in the query match literally;
- query composes with the category filter and with cursor pagination.
No component-test framework exists in the repo (vitest only, no
@testing-library), so the shell wiring is covered by the server tests plus
manual QA — same coverage level PR #250 shipped with. Adding a component
framework is a separate decision, not smuggled into this PR.
Run: browse-page + homepage-data suites, eslint, tsc.

## Deploy (rule 19)

- Work committed on `feat/search-full-catalog` (cut off fresh origin/main @
  5fba547). PR into `main`; no schema/migration/env change; standard pipeline
  deploy on merge; nothing promoted manually in Vercel.

## Open questions

- Search result ordering is recency (the browse order), not relevance. Fine
  for substring search over titles; revisit with FTS if needed.
