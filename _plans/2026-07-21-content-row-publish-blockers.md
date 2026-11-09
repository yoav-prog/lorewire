# Content list: show publish blockers inline per row

Date: 2026-07-21
Branch: feat/content-publish-blockers

## Goal

On /admin/content, stories that would be rejected by Publish (missing poll,
missing thumbnail, missing short, etc.) currently look identical to ready
ones. The operator only discovers what is missing after clicking Publish and
reading the failure banner. Requirement: each story row shows what is missing
up front, with no click needed.

## Constraints

- The page loads up to 100 rows per fetch (200 on refresh). The existing
  per-story gate (`evaluateAssetCompleteness`) runs ~5 queries per story, so
  calling it per row would mean hundreds of queries per page load. A batched
  evaluator is required.
- Single Source of Truth: the row chip must agree exactly with the real
  publish gate. Two independent implementations of "what blocks publish"
  would drift.
- `repo.ts` cannot import `asset-completeness.ts` (cycle via `polls.ts` ->
  `repo.ts`), so the enrichment happens in the server action layer.

## Approach (chosen)

1. `src/lib/asset-completeness.ts`
   - Extract the gate derivation into a pure `deriveAssetCompleteness(inputs)`
     used by both paths.
   - Keep `evaluateAssetCompleteness(storyId)` with its exact signature and
     behavior (all existing callers and its 17 tests unchanged). It now
     assembles inputs and calls the shared derive. The `getRedditSource`
     fetch is dropped: every source-derived readiness message is unmapped in
     the gate (verified), so the query was dead weight in the cron loops.
   - Add `evaluateAssetCompletenessForStories(storyIds)` -> Map<id,
     AssetCompleteness>. Three batched queries: stories (+ correlated
     latest-done-short-render check), polls, and `short_config` only for the
     subset whose short render is missing (the only case the gates read it).
     For stories with a done short, the scene/voiceover *details* fields
     read as absent - documented; only `blocking`/`missing`/`ready` are
     contract for list consumers.

2. `src/lib/repo.ts`: `ContentRow` gains `publish_blockers: AssetGate[] |
   null` (type-only import). `loadContentPage` / `listContentSlim` set it to
   null; null means "not evaluated" (articles, published/archived stories).

3. `src/app/admin/actions.ts`: `listContentPageAction` evaluates the batch
   for the page's non-published, non-archived stories and writes each row's
   `blocking` list onto `publish_blockers`. `[]` = ready to publish.

4. `ContentList.tsx`: story rows with a non-empty `publish_blockers` render
   an amber `missing: ...` pill (up to 3 short labels + "+N", full detail in
   the tooltip, including the hint that Complete & publish backfills).

## Alternatives rejected

- Per-row `evaluateAssetCompleteness` calls: correct but ~500 queries per
  page load; the list auto-polls while renders are active, multiplying it.
- Duplicating the gate logic in SQL inside `loadContentPage`: fast but a
  second source of truth for publish readiness; drift is guaranteed the next
  time a gate is added.

## Testing

- Existing 17 `asset-completeness.test.ts` cases now exercise the shared
  derive through the single-story path (regression net for the refactor).
- New: batch returns empty map for empty input; unknown ids absent;
  single-vs-batch parity across seeded scenarios (complete, missing
  thumbnail, missing short with scene hints, disabled poll, empty video_url,
  already published); multi-story batch in one call; latest-done-render
  semantics (newer done row without output_url wins and reads as missing).
- Out of scope: component render test for the pill (no test harness exists
  for ContentList; server-side gate data is the load-bearing part).

## Security

No new surface. Gate data flows only through `listContentPageAction`, which
requires the `content.manage` capability. Read-only queries, parameterized
IN lists.

## Observability

- `[asset gate] batch` log: story count in / evaluated.
- `[content publish-blockers] page` log in the action: candidates + how many
  have blockers.

## Settings

Intentionally no toggle: the chip only appears on rows that cannot publish,
admin-only surface, zero cost when everything is ready.

## Deploy

Normal flow: PR from `feat/content-publish-blockers` into `main`; merge
deploys via Vercel. No env vars, no schema changes (reads existing columns).
Rollback = revert the PR.
