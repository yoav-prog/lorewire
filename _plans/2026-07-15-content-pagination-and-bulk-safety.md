# Content inbox: server-driven pagination + bulk-action safety spine

- **Date:** 2026-07-15
- **Status:** Approved in principle. Phase 0 approved for build as its own PR; Phases 1-2 deferred until Phase 0 is shipped and verified.
- **Owner:** Yoav
- **Area:** `/admin/content` (the unified stories + articles inbox)

## Problem

The admin Content page silently shows only the 200 most-recently-updated
items. The library is ~237 rows today and the site shows 237 live stories,
so ~37 of the oldest-updated rows are invisible with no signal beyond a
small footer note. The 200 cap is `LIST_LIMIT` in
`src/app/admin/(panel)/content/page.tsx:31`, applied both as a per-table
SQL `LIMIT` (`listStoriesSlim` / `listArticlesSlim`) and a final merged
`slice(0, limit)` in `listContentSlim` (`src/lib/repo.ts`).

The owner expects the library to grow into the thousands (the Reddit
pipeline + autopilot automation feed it). So the fix is not "raise the
number" — it is real server-driven pagination, server-side search, and
server-side filtering, with Select All able to reach the whole dataset.

## The hidden complication

The row list is a client component (`ContentList`) that assumes it holds
the COMPLETE working set. Three things ride on that assumption:

1. The search box filters `rows` in memory (`matchesContentSearch`).
2. Select All selects the visible rows; every bulk action operates on that
   in-memory `{kind,id}` list.
3. Two one-click buttons ("Regenerate ALL published shorts", "Reclassify")
   count and act by scanning the loaded rows.

Additionally, three filters are aggregates computed IN MEMORY after the
200-row fetch, not columns: Published-on (4 `*_posts` tables), Job status
(latest `story_jobs` per `reddit_id`), Active render
(`short_renders`/`image_renders`/`voice_renders`). Whole-dataset Select All
and accurate total counts require these to move into SQL.

## Goals

- Show the whole library, paged, without loading it all into the browser.
- Server-side search and filtering that reach every row, not just a page.
- Select All that can mean "all N matching" for safe, reversible actions.
- Make an irreversible or four-figure bulk mistake structurally impossible,
  not merely confirmation-gated.
- Ship the safety work FIRST, independently, before the cap is removed.

## Non-goals (explicitly out of scope)

- A saved-views / serializable-predicate / rules automation engine. The
  council flagged this as scope inflation that amplifies blast radius for a
  one-operator tool. Deferred indefinitely (see Rejected alternatives).
- Full soft-delete / trash / restore for stories with media-retention
  changes. Valuable, but a cross-cutting feature touching the public read
  path and R2/GCS retention. Its own future plan.
- Full-text search engine. `LOWER(col) LIKE LOWER(?)` is sufficient at
  low-thousands scale; revisit only if it gets slow.

## Constraints

- **Cross-DB.** The query layer runs SQLite (tests) and Postgres (prod)
  through `all`/`one`/`run` with `?` placeholders. All new SQL must be
  portable: case-insensitive search via `LOWER(col) LIKE LOWER(?)`, no
  DB-specific pagination syntax, keyset over `(sortkey, id)`.
- **One operator, internal, behind `requireCapability("content.manage")`.**
  Not public. This is why "build for scale" is bounded — the pressure is
  data volume, not concurrency.
- **The page works today.** No big-bang rewrite. Every phase must leave the
  page shippable.
- **Messy sort key.** Rows sort by `COALESCE(updated_at, created_at) DESC`.
  Pagination must keyset on that exact expression plus `id` as a tiebreak.

## Decisions locked with the owner

1. **Build for scale** — server-driven pagination + server search + server
   filtering. Not a client "load more" that keeps everything in memory.
2. **Select All reaches the entire dataset** — but SPLIT BY DANGER:
   - Cheap, reversible actions (publish/unpublish, set status, set
     category) MAY operate by filter over the whole matching set.
   - Paid or destructive actions (DELETE, regenerate short/pipeline/scenes/
     voice/hero, complete&publish, refresh-assets, publish-to-socials)
     operate ONLY on explicitly ticked rows, hard-capped low. No
     "apply to all N matching" path exists for them. This makes the
     catastrophic click architecturally impossible.
3. **Phase 0 (safety) ships first as its own PR**, verified in-app, before
   any pagination code lands.

## Architecture (the long-term picture)

- **Pagination:** `UNION ALL` of the two slim projections
  (`stories`, `articles`) into a common shape, keyset-paginated on
  `(COALESCE(updated_at, created_at), id)` DESC. The only mechanism correct
  under concurrent writes, index-friendly, and portable across both DBs.
  Reject OFFSET (unstable, O(n)) and app-side stream-merge (fragile).
- **Enrichment stays a post-step:** after the page's id-set is chosen,
  batch-load published-on / progress / job-status for those ids (the
  existing `loadPublishedOnByStoryIds` etc.), exactly as today but scoped to
  one page.
- **Counts:** a `COUNT(*)` over the same `UNION ALL` + WHERE, for "N items"
  and the "Select all N matching" affordance.
- **Action model:** two classes. Safe/reversible → may resolve an id-set
  from filter criteria server-side. Paid/destructive → ticked ids only,
  low cap, enforced in the handler.

## Phasing

### Phase 0 — Safety spine (THIS PR, ~1 day, no pagination touched)

Concrete, grounded changes:

1. **Per-class server-side caps in `src/app/admin/actions.ts`.** Introduce
   `DELETE_CAP` and `PAID_BULK_CAP` (proposed 50 each) enforced INSIDE each
   dangerous handler (`bulkDeleteContentAction`,
   `bulkRegenerateContentAction`, `bulkCompleteAndPublishAction`,
   `bulkRefreshAssetsAction`, `bulkPublishToSocialsAction`) — not just the
   shared `MAX_BULK_ITEMS=200` in `validateItems`. Throw before doing any
   work if exceeded. Defense in depth: holds even if the client is bypassed,
   and is already in place when Phase 1 removes the 200 cap.

2. **Total-cost line + spend confirmation in `RegenConfirmModal`
   (`ContentList.tsx:1841`).** Today it shows `"≈ $1.13 per story × 40"`
   but never the total. Add a `REGEN_TARGET_COST` numeric map
   (short ≈ 1.13, pipeline ≈ 0.50, voice ≈ 0.38 worst-case; hero/scenes are
   daily-budget-gated so show "budget-gated" not a total) and render a bold
   `≈ $X total`. For runs over a spend threshold (proposed $20), require a
   typed confirmation echoing the count (same pattern as the DELETE input).

3. **Audit every bulk destructive + paid run.** Extend `src/lib/audit.ts`:
   add `AuditAction` keys `content.bulk_delete`, `content.bulk_regenerate`
   (and optionally `content.bulk_publish`), and an `AuditTargetType` of
   `"content"`. Write one summary row per run, BEFORE the mutation
   (fail-closed: no audit row → action aborts, matching audit.ts
   philosophy and rule 13), with PII-free metadata:
   `{ target?, count, ids (capped), estCostUsd?, storyCount, articleCount }`.

4. **Clearer irreversibility warning on DELETE.** The delete modal
   (`ConfirmModal:1588`) already requires typing DELETE and warns media is
   purged. Reinforce "this cannot be undone — there is no trash" so the
   bounded-but-permanent nature is explicit. (Full soft-delete is deferred;
   see Open questions.)

5. **Verify paid regenerate idempotency holds.** The bulk regen loop is
   already idempotent against in-flight work (voice race-loss, pipeline
   active-job gate, short in-flight handling). Add a test that a re-run of
   an in-flight batch does not double-enqueue. No queue rewrite.

QA: golden path (tick 3 rows, regen, see total + audit row); cap path
(51 rows rejected server-side); bypass path (hand-crafted 51-item call
throws); spend-threshold typed confirm; audit-write-failure aborts the
delete; idempotent re-run test.

### Phase 1 — Server-driven pagination + search + column filters (next PR)

- `listContentSlim` → keyset UNION pagination + `COUNT(*)`; add a server
  search param (`LOWER(...) LIKE LOWER(?)` over title/slug/id, per table).
- `ContentList` becomes a thin renderer of the current page; search box and
  filters drive server round-trips (URL params, same as the existing chips).
- Dataset-wide "Select all N matching" for SAFE actions only, implemented
  as a filter-snapshot the server re-resolves (re-checks count at
  execution). Paid/destructive stay ticked-ids-only from the loaded page.
- The three aggregate filters are disabled while "select all matching" is
  armed, until Phase 2 moves them into SQL. Never let Select All silently
  ignore an active in-memory filter.

### Phase 2 — Aggregate filters into SQL (follow-up PR)

Published-on / job-status / active-render become EXISTS subqueries /
latest-row joins in the paginated query, re-enabling them under
dataset-wide selection and accurate counts. Free byproduct: these become
queryable operational state (coverage, backlog).

## Rejected alternatives

- **Just raise the cap to ~1000 (council minority: Contrarian, Outsider).**
  Honestly the cheapest thing that works for a year at this scale, and it
  was offered first. Rejected because the owner expects thousands and wants
  the durable fix; but its spirit is honored by phasing (Phase 0 alone
  already fixes the danger; pagination is deferred and minimal).
- **OFFSET/LIMIT pagination.** Unstable under concurrent writes (rows shift
  between pages as automation inserts), O(n) scans. Rejected.
- **App-side merge of two ordered streams.** More code, fragile edge cases
  at page boundaries. Rejected in favor of `UNION ALL` in SQL.
- **Whole-dataset Select All driving DELETE/regenerate.** The owner's
  literal first framing. Rejected per the danger-split decision: it builds
  the one button that turns a tired click into thousands of dollars or an
  irreversible wipe.
- **Predicate / saved-views / rules engine (Expansionist).** Over-scope for
  a one-operator tool; amplifies blast radius. Deferred indefinitely.
- **Full soft-delete/trash now.** Best blast-radius reducer in principle,
  but a cross-cutting feature (media retention, public queries, restore UX).
  Bolting it into a safety PR bloats scope and risk. Deferred to its own
  plan; the ≤50 cap + typed confirm + audit bound the risk meanwhile.

## Security & safety (rule 13)

- **Attack surface / misuse:** the real risk is operator error, not an
  external attacker (internal, single-operator, capability-gated). The
  danger is a bulk action hitting far more rows / dollars than intended.
- **Defense in depth:** caps enforced server-side in the handler, not only
  the UI. A crafted client call over the cap fails closed.
- **Fail closed:** audit row written before the mutation; if the audit
  write fails, the destructive/paid action does not run.
- **Least surprise:** dangerous actions cannot target unseen rows at all
  (ticked-ids-only). Confirmation shows the server's real count and cost.
- **No new secrets, no new external surface.** No PII added to audit
  metadata (ids are opaque; follows the existing hashed-label design).
- **Idempotency:** paid enqueues skip in-flight work so a retry can't
  double-spend.

## Cost (rule 8)

No new paid service. This work REDUCES spend risk: it prevents an
accidental bulk regenerate (short ≈ $1.13/story) from silently costing
four figures. No pricing lookup needed — the per-story figures come from
the existing `REGEN_TARGET_META` hints; representative numbers will be
encoded for the total-cost display and can be tuned in one map.

## Open questions / flagged sub-decisions

1. **Caps:** `DELETE_CAP` / `PAID_BULK_CAP` = 50? (Big enough for real
   batches, small enough to bound a misclick.) Tunable in one constant.
2. **Spend-confirm threshold:** typed confirmation for regenerate runs over
   ~$20? 
3. **Bulk delete semantics:** keep hard-delete-but-bounded for Phase 0
   (recommended — a safety PR should not also change what "Delete" means),
   with full soft-delete/trash as a separate later plan. Alternative: make
   bulk Delete = Archive (reversible) now and reserve hard delete for tiny
   typed batches. Owner to confirm.
4. **Audit granularity:** one summary row per run (recommended) vs one row
   per affected item (per-story trail).
5. **Voice-regen idempotency gap (found during Phase 0 build):**
   `enqueueVoiceRender` dedupes via a partial unique index over
   `(story_id, text_hash, voice_provider, voice_id)` WHERE status IN
   ('queued','processing'). SQL treats NULL as distinct, so a story with no
   voice override (voice_provider/voice_id NULL — the default case) does NOT
   hit the conflict and a retry double-enqueues a voice render. The ≤50 paid
   cap bounds the blast radius (~$2-19, not four figures). A null-safe
   uniqueness check is a scoped follow-up — a cross-DB queue change, out of
   scope for the safety spine. Test `bulk-content-actions.test.ts` pins the
   voice-set idempotent path so a regression there is caught.

## Branch hygiene (AGENTS.md)

Phase 0 is unrelated to the current `feat/imprint-legal-gdpr` branch. Build
it on a fresh branch cut from an up-to-date `main` (`git fetch`, verify
`main` is not behind production, branch, then work). Do not add these
commits to the imprint branch.
