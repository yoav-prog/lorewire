# Reddit DB sync — import, review, publish workflow

**Status:** draft — awaiting approval before Phase 2+ ships
**Owner:** Yoav (info@flexelent.com)
**Date:** 2026-06-14

## Goals

A curated **import → review → publish** pipeline for Reddit story candidates sourced from an external spreadsheet, sitting upstream of the existing `stories` flow.

- Bulk-load Reddit story candidates from a CSV the user owns ("RedditDB")
- Deduplicate strictly by `Reddit ID`
- Browse, filter, search the candidate pool from the admin
- Bulk-select N rows and send them into the existing scrape→idea→research→article→media→video pipeline
- Only the user clicking **Publish** flips a story public — gated on reviewing article body, images, and video

## Constraints

- Dual-driver storage (SQLite locally, Postgres on Vercel) — every schema and helper mirrors the existing pattern in [pipeline/store.py](pipeline/store.py) and [lorewire-app/src/lib/schema.ts](lorewire-app/src/lib/schema.ts)
- Existing Reddit ID is already the universal slug across `stories.reddit_id`, the pipeline, and live URLs — must remain the single source of truth
- Existing story status workflow is `draft → review → published`; we extend it, not replace it
- The non-standard Next.js variant means all admin UI work must follow [lorewire-app/AGENTS.md](lorewire-app/AGENTS.md) and reference `node_modules/next/dist/docs/` before writing code

## Requirements (as stated by user)

1. **Reddit ID is the unique key, no duplicates.** Strict PK, upsert on conflict.
2. **CSV upload from the admin.** "Whenever I need" — explicit, on-demand, file picker, no scheduled cron.
3. **Bulk add to pipeline.** Multi-select rows from the candidate list and process all/some.
4. **Publish only after review.** No automatic public release. Click-to-publish after eyeballing the article, hero image, and video.
5. **Robust filter and search.** Filter (subreddit, length, comments, date, status) and free-text search on candidate rows.

## End-to-end flow

```
   CSV file
      │
      ▼  Phase 1 (Python sync)
┌────────────────┐
│ reddit_source  │  ← new table: PK reddit_id, status='imported'
└────────┬───────┘
         │  Phase 2 (admin browse: filter/search/multi-select)
         ▼
   "Process N" action
         │  Phase 3 (worker enqueue)
         ▼
   pipeline run for each ─→ stories.status='review' (existing path)
                                       │
                                       │  Phase 4 (admin review page)
                                       ▼
                                  [ Publish ]  ─→ status='published'
                                                  reddit_source.status='used'
```

## Database schema

New table mirroring the existing dialect-agnostic pattern. Mirrors land in **both** [pipeline/store.py](pipeline/store.py) `SCHEMA_STATEMENTS` and [lorewire-app/src/lib/schema.ts](lorewire-app/src/lib/schema.ts).

```sql
CREATE TABLE IF NOT EXISTS reddit_source (
  reddit_id      TEXT PRIMARY KEY,
  subreddit      TEXT NOT NULL,
  date_written   TEXT NOT NULL,        -- ISO from sheet, normalized at parse
  title          TEXT NOT NULL,
  full_text      TEXT NOT NULL,
  comments       INTEGER,
  url            TEXT,
  summary        TEXT,
  length_chars   INTEGER,
  status         TEXT NOT NULL DEFAULT 'imported',
                                       -- imported | queued | processing | used | skipped
  story_id       TEXT,                 -- FK to stories.id once processed (nullable)
  notes          TEXT,                 -- admin free-text per row (rejection reason, etc.)
  first_synced   TEXT NOT NULL,
  last_synced    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reddit_source_status      ON reddit_source(status);
CREATE INDEX IF NOT EXISTS idx_reddit_source_sub_len     ON reddit_source(subreddit, length_chars);
CREATE INDEX IF NOT EXISTS idx_reddit_source_comments    ON reddit_source(comments DESC);
CREATE INDEX IF NOT EXISTS idx_reddit_source_date        ON reddit_source(date_written DESC);
```

**Why these indices:** the candidate list is filterable by subreddit + length + comments + date + status. Three of those get their own index; combined predicates lean on `status` first (smallest selectivity), then narrow.

**Upsert semantics:**
- First sync of a row: insert with `status='imported'`, `first_synced` and `last_synced` = now.
- Re-sync of an existing row: only refresh `title`, `summary`, `comments`, `full_text`, `length_chars`, `last_synced`. **Never** touch `status`, `story_id`, or `notes` — those are the admin's state.

## Status state machine

```
reddit_source:    imported ─────┬─→ queued ─→ processing ─→ used
                                │       (worker picks up)
                                └─→ skipped (admin rejects)

stories:          draft / review ─→ published  (existing workflow, untouched)
```

Transitions:
- `imported → queued`: admin multi-selects rows and clicks "Process N"
- `queued → processing`: pipeline worker claims the row (atomic flip, same pattern as `claim_next_render`)
- `processing → used`: worker finishes story creation; sets `story_id`
- `imported → skipped`: admin manually rejects (with optional `notes`)
- `used → imported`: admin re-opens (rare; for re-processing)

## CLI

New standalone module, following the `python -m pipeline.models` precedent (cleaner than threading a subparser through `pipeline.run`):

```
python -m pipeline.reddit_db_sync --csv ref/redditdb.csv             # parse + upsert
python -m pipeline.reddit_db_sync --csv ref/redditdb.csv --dry-run   # diff only, no writes
```

Output on the real CSV at [ref/MSN-RSS-Researcher-Reddit - RedditDB.csv](ref/MSN-RSS-Researcher-Reddit%20-%20RedditDB.csv) (verified end-to-end on a tmp DB):
```
[reddit-sync parse] file=… rows=31572 warnings=732 elapsed_ms=585
[reddit-sync apply] mode=live new=30840 updated=0 unchanged=0 errors=0 elapsed_ms=18784
```

Performance: parse + diff in ~5 s, full insert of 30k rows in ~19 s — driven by a single-SELECT snapshot for diffing and `executemany` inside one transaction for writes. Per-row helper calls would take 17+ minutes on Windows, which is what motivated the bulk path.

Phase 3 adds the row-by-row processing subcommand (`process-reddit-source --id <rid>`).

## Admin UI (Phase 2+)

**Sidebar entry:** `Reddit Sources` (between Stories and Articles).

**`/admin/reddit-sources/import`** — Phase 2
- File picker accepting `text/csv`
- Validates header row matches the expected 9 columns (per ref/MSN-RSS-Researcher-Reddit - RedditDB.csv)
- Streams to temp path under `pipeline/_uploads/` (gitignored)
- Server action shells out: `python -m pipeline.run sync-reddit --csv <path>`
- Displays diff summary: `12 new, 4 updated, 3 errors with line numbers`

**`/admin/reddit-sources`** — Phase 2
- Paginated table (50/page) with virtual scroll on the in-page rows
- Columns: checkbox · subreddit · title · length · comments · date · status · actions
- **Filters** (left rail, persisted in URL query):
  - Subreddit (autocomplete multi-select, reuses [SubredditAutocomplete.tsx](lorewire-app/src/app/admin/(panel)/settings/_components/SubredditAutocomplete.tsx))
  - Length: min/max chars
  - Comments: minimum
  - Date range: ≥ / ≤
  - Status: multi-select (default = `imported`)
- **Search** (top bar): substring on `title` OR `summary`, case-insensitive
- **Bulk actions** (sticky footer when N selected):
  - Process N → flips to `queued`, enqueues pipeline jobs
  - Skip N → flips to `skipped`, optional reason
- **Per-row** quick actions: View source post (URL), Skip, Open story (if processed)

**`/admin/reddit-sources/[reddit_id]`** — Phase 4
- Full review page: source post pane on left, generated `stories` row on right with hero, scenes, video preview
- `[ Publish ]` and `[ Reject ]` primary actions
- Publish: sets `stories.status='published'`, `published_at=now`, `reddit_source.status='used'`
- Reject: sets `reddit_source.status='skipped'`, leaves the draft story for inspection but un-queues anything pending

## Security (rule 13)

- **Auth:** all new admin routes wrapped in `requireAdmin()` matching existing pattern
- **File size cap:** 50 MB on the upload (current CSV is 512 KB; 100× headroom is plenty, anything larger is almost certainly wrong)
- **MIME validation:** accept only `text/csv` (with content sniff fallback to first-line header check)
- **Temp path traversal:** files written to `pipeline/_uploads/redditdb-<utc-iso>-<random>.csv` (no user-controlled bytes in path)
- **CSV formula injection:** if any field starts with `=`, `+`, `-`, `@`, `\t`, `\r` — prefix with `'` before any future re-export. Not load-bearing on read (we never `eval`), but cheap insurance for round-trips.
- **DB writes:** `executemany` with bound parameters only — no string interpolation of cell values
- **Cleanup:** uploaded CSVs older than 30 days deleted by a sweep ran on every sync (1 line, no separate job)
- **Sensitive data:** Reddit posts are public; nothing here is PII-sensitive. The upload URL stays admin-only.

## Observability (rule 14)

Every step gets a namespaced log line `[reddit-sync <step>]` with structured values, mirroring the codebase convention:

```
[reddit-sync parse] file=<path> rows=31572 errors=0 elapsed_ms=1834
[reddit-sync diff] new=12 updated=4 unchanged=31556 skipped=0
[reddit-sync upsert] table=reddit_source rows_written=16 elapsed_ms=287
[reddit-sync queue] reddit_ids=[…] queued_by=admin@…
[reddit-sync process] reddit_id=<id> story_id=<sid> status=queued→processing
[reddit-sync publish] reddit_id=<id> story_id=<sid> status=used published_at=…
```

Admin UI surfaces these via:
- The diff summary banner on `/admin/reddit-sources/import` after a sync
- A small "Last synced: <ts> · 12 new, 4 updated" line on `/admin/reddit-sources`
- Per-row `notes` field for skip/reject reasons

## Settings audit (rule 15)

New settings exposed in `/admin/settings`:

- `reddit_source.default_filter.subreddits`: pre-seeded multi-select for new browsing sessions (default: Tier 1 list from research)
- `reddit_source.default_filter.length_min`: default min char filter (default: 1500)
- `reddit_source.default_filter.length_max`: default max (default: 6000)
- `reddit_source.default_filter.comments_min`: default min (default: 100)
- `reddit_source.upload.max_mb`: server cap on upload size (default: 50)
- `reddit_source.csv_filename_hint`: cosmetic; shown on the import page as expected filename

Intentionally NOT exposed:
- Status transition rules (engineering invariant, not user preference)
- DB indices (engineering)
- Auto-process toggle — we are explicitly building this for human review only

## Testing (rule 18)

**Phase 1 (Python):**
- `tests/test_reddit_db_sync.py`:
  - Parse the actual file at [ref/MSN-RSS-Researcher-Reddit - RedditDB.csv](ref/MSN-RSS-Researcher-Reddit%20-%20RedditDB.csv) (smoke: returns 31572 rows)
  - Parse a small fixture CSV with all 9 columns
  - Encoding edge cases: smart quotes, em dashes, the `�` we already saw
  - Missing column → clear error, not silent skip
  - Reddit ID duplicate within file → keep last occurrence, log a warning
  - Upsert idempotency: sync twice, `new=N, updated=0` on second run
  - Re-sync does NOT clobber `status`, `story_id`, `notes`
  - Comments field gracefully tolerates "", "12", "1.2K" (Reddit-styled, just in case)
  - Length field falls back to `len(full_text)` if absent/zero
- `tests/test_store_reddit_source.py`:
  - `upsert_reddit_source` round-trip on SQLite
  - `list_reddit_sources` filter combinations
  - `count_reddit_sources` matches `len(list)` under same filter

**Phase 2 (admin):**
- File picker → server action → diff summary path: happy path + 3 error paths (no file, wrong MIME, bad headers)
- Filter URL persistence: round-trip query → DB query → row count

**Phase 3 (bulk process):**
- Multi-select → status flip atomic: 2 concurrent clicks don't double-queue
- Worker claim race: 2 workers can't both claim same row (mirrors `claim_next_render` test)

**Phase 4 (publish gate):**
- Publish action requires `stories.video_url IS NOT NULL` (no half-baked publishes)
- Reject preserves draft story for inspection

## Alternatives considered (and rejected)

1. **Public CSV URL fetch.** Sheet must be link-shared; leaks even if URL stays secret. CSV upload is simpler and source-agnostic.
2. **Reuse existing Sheets integration ([lib/sheets.ts](lorewire-app/src/lib/sheets.ts)).** Already works for articles. Rejected because user explicitly chose CSV upload, and the dependency on Google service account + sheet sharing adds an ops burden a file picker doesn't. We *could* layer it on later (the parse+upsert path is identical).
3. **Mirror everything into `articles` table.** Articles are TS-owned text content; Reddit candidates are upstream raw material with their own lifecycle. Separate table is the right boundary.
4. **Apply Tier 1 / length / comments filter at ingest.** Throws away data we may want later; cheap to filter at query time. Mirror everything, filter at consume.
5. **Auto-publish stories that pass a quality threshold.** Explicitly out of scope — the user's whole point is "publish only after I see it."

## Phasing & deliverables

**Phase 1 — Python sync + CLI + tests (today's session):**
- [ ] `reddit_source` table in `pipeline/store.py` SCHEMA_STATEMENTS
- [ ] Mirror in `lorewire-app/src/lib/schema.ts`
- [ ] `pipeline/reddit_db_sync.py`: `parse_csv()`, `compute_diff()`, `apply()`
- [ ] Store helpers: `upsert_reddit_source`, `list_reddit_sources(filters)`, `count_reddit_sources(filters)`, `fetch_reddit_source(reddit_id)`, `set_reddit_source_status`
- [ ] CLI subcommand `sync-reddit` on `pipeline/run.py`
- [ ] `tests/test_reddit_db_sync.py`, `tests/test_store_reddit_source.py`
- [ ] Run a real sync against the actual CSV in `ref/` and verify counts

**Phase 2 — admin import + browse:**
- Read `node_modules/next/dist/docs/` per AGENTS.md
- `/admin/reddit-sources/import` page + server action
- `/admin/reddit-sources` browse page with filter/search
- Sidebar entry, settings, tests

**Phase 3 — bulk process trigger (shipped 2026-06-14):**
- ✅ `story_jobs` queue table in [pipeline/store.py](pipeline/store.py) + mirror in [lorewire-app/src/lib/schema.ts](lorewire-app/src/lib/schema.ts), mirroring the `video_renders`/`image_renders` shape (id, reddit_id, status, progress, error, story_id, with_media, requested_*/started_*/finished_*).
- ✅ Python store helpers: `enqueue_story_job` (idempotent via `has_active_story_job`), `claim_next_story_job` (atomic, FOR UPDATE SKIP LOCKED on PG / conditional UPDATE on SQLite), `update_story_job_progress`, `finish_story_job`, `fail_story_job`, `get_story_job`, `latest_story_job_for_reddit`, `count_pending_story_jobs`, `reap_stale_story_jobs`.
- ✅ Worker at [pipeline/story_jobs_worker.py](pipeline/story_jobs_worker.py): poll loop + per-job pipeline (idea → research → article → branded title/synopsis → media → video → upsert_story); reaps stale claims on every tick; sets `reddit_source.status` to `processing` → `used` (on success) or back to `queued` (on failure) so a re-pick is possible. CLI flags: `--once`, `--reddit <id>` (queue bypass), `--no-media`, `--poll-seconds N`.
- ✅ TS helpers in [lorewire-app/src/lib/story-jobs.ts](lorewire-app/src/lib/story-jobs.ts): `bulkEnqueueStoryJobs` (atomic — snapshots source statuses + active jobs, only enqueues `imported`/`queued` rows that have no active job, returns `{enqueued, skipped_active, skipped_status, not_found, enqueued_ids}`), `listLatestStoryJobsForReddit`, `getLatestStoryJobForReddit`, `countPendingStoryJobs`.
- ✅ Server action `processRedditSourcesAction` in [actions.ts](lorewire-app/src/app/admin/actions.ts) that requireAdmin, calls bulkEnqueueStoryJobs, revalidates, redirects to the queued+processing view with diff counts in the URL.
- ✅ "Process N" button live in [RedditSourceTable.tsx](lorewire-app/src/app/admin/(panel)/reddit-sources/RedditSourceTable.tsx) bulk footer with confirm dialog naming the worker command.
- ✅ Tests: 13 Python tests in `pipeline/tests/test_story_jobs.py` (enqueue idempotency, atomic claim, finish/fail with cancellation guard, stale reap, worker happy-path + failure + missing-source) + 9 TS tests in `src/lib/story-jobs.test.ts` (bulk enqueue partitioning, idempotency, with_media flag, empty input no-op, re-enqueue after done).

How to run end-to-end (local):
```
# Terminal 1 — admin
cd lorewire-app && npm run dev
# Terminal 2 — worker
python -m pipeline.story_jobs_worker --poll-seconds 5
```
Then in /admin/reddit-sources, select rows → Process N. The worker picks them up and writes `stories` rows with `status='review'` (Phase 4 will gate the publish step on a human review).

**Phase 4 — review + publish gate (shipped 2026-06-14):**
- ✅ Pure helper `evaluatePublishReadiness(story, source)` in [lorewire-app/src/lib/reddit-source.ts](lorewire-app/src/lib/reddit-source.ts) — returns `{ready, missing[]}`. Blocks: source not `used`, story missing, body empty, hero missing, video unrendered, already published, archived. Drives both the disabled state on the Publish button and the server-side guard so a hand-crafted POST can't bypass it.
- ✅ Three server actions in [actions.ts](lorewire-app/src/app/admin/actions.ts):
    - `publishReviewedStoryAction` — runs the gate, flips `stories.status='published'` + `published_at`, redirects with `?published=1`. When blocked, redirects with `?publish_blocked=<reason1>|<reason2>` so the review page surfaces every missing piece in one round trip.
    - `rejectReviewedStoryAction` — archives the story (`stories.status='archived'`); `reddit_source.status` stays `used` so re-process is one explicit click away.
    - `reprocessRedditSourceAction` — archives the prior story and resets `reddit_source.status='imported'` with `story_id=null` so the row can be re-enqueued through the existing Phase 3 bulk action.
- ✅ Review page at [/admin/reddit-sources/[reddit_id]](lorewire-app/src/app/admin/(panel)/reddit-sources/[reddit_id]/page.tsx). Two-pane layout (source post left, generated story right with hero + native HTML5 video player + body + scene gallery). Five-state branch so every source status renders something useful (imported / queued / processing / used / skipped). Status chips at top + readiness panel + footer with Reject / Re-process / Publish.
- ✅ Title cells in the browse table now link to the review page.
- ✅ Tests: 10 readiness-gate unit tests covering every blocker reason + accumulation across multiple blockers in one pass.

Done conditions for the whole plan are now met: import → review → publish, deduped on Reddit ID, with filter/search at every step, multi-select bulk processing, and a hard publish gate keyed on body + hero + video + finished worker run. The remaining cleanup belongs to future plans: a partial unique index on `(reddit_id) WHERE status IN ('queued','processing')` for high-concurrency production, a daily-budget cap that aborts in-flight worker batches, and a Vercel drain endpoint mirroring [drain_image_renders](lorewire-app/api/drain_image_renders.py) so the worker doesn't have to run on a laptop.
