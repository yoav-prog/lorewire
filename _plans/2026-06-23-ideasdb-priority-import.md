# IdeasDB priority import

**Date:** 2026-06-23
**Branch:** feat/article-comments-restored (next branch: feat/ideasdb-priority-import)
**Author:** Yoav + Claude (Opus 4.7)
**Council pass:** yes — see "Council verdict" section below

## Goal

Upload Yoav's curated "IdeasDB" Google Sheet (~2000 rows) into the existing
Reddit Sources admin. Each row is a story idea Yoav has hand-picked. When
the row's `Source` column matches a `reddit_source` row we already have,
flip that row to priority. When it doesn't match (raw idea with no reddit
post backing it), insert a new seed row that the worker can still process
end-to-end via an LLM expansion stage. Only `Type=Story` rows are in scope;
`List` rows are ignored.

## Constraints

- Python pipeline (SQLite dev, Postgres prod) + Next.js admin.
- Existing reddit CSV importer (9-column format) keeps working untouched.
- Status conflicts: priority flips are non-destructive on `used`/`skipped`.
- Sheet is the source of truth and *will* be re-uploaded weekly — every
  re-import is dry-run by default and must produce a per-row diff before
  it mutates state.
- 2000-row Vercel HTTP upload is out of scope (timeout). Import is a CLI
  in v1; admin button is a week-2 wrapper.
- Existing `reddit_source.full_text`, `subreddit`, `date_written`, `title`
  are `NOT NULL`. We add only nullable columns; idea-only rows write
  empty/placeholder values into the legacy NOT NULL columns.

## Requirements

### Functional

- `Type=Story` rows where `Done Already? == 'Yes'` are skipped.
- Strength `Strong`/`Medium` maps to the priority enum
  (`strong`/`medium`/`none`).
- `Source` parsing: first whitespace token is the canonical match key;
  additional tokens are fanned out (their matching seeds also get the
  strength flip). All tokens surface in the dry-run diff.
- Match-key resolution order:
  1. First Source token matches an existing `reddit_source.reddit_id` →
     update that seed.
  2. No match → normalized fingerprint of `headline + category`
     (lowercased, whitespace-collapsed) → if existing seed has the same
     fingerprint, update it.
  3. No match → insert a new seed.
- Status conflicts (`status in ('used','processing')`): update strength,
  leave status alone, surface in diff.
- `Done=Yes` flipped on (Sheet edit): if seed.status ∉ (`used`,
  `processing`), set status `skipped`. Otherwise no-op.
- `Done=Yes` flipped off: if status `skipped`, restore to `imported`.
  Otherwise no-op.
- Headline edit (same match key): update headline/summary/category.
  If seed was LLM-expanded already AND Levenshtein(new headline, old
  headline) / max(len) > 0.30, set `needs_expansion=1`.
- Row vanished from Sheet (seed exists in DB with `source_hint != ''`
  but not in latest import): no-op. Surface count in diff.

### Non-functional

- Dry-run by default. `--apply` flag commits.
- Per-row diff written to `ideas_import_log` table on every run
  (dry or apply), keyed by run UUID.
- Idempotent on re-run with the same CSV.
- Logs every step under `[seeds-import …]` and `[seeds-worker …]`
  namespaces per rule 14.

## Data model

### Existing `reddit_source` — add nullable columns only

```sql
ALTER TABLE reddit_source ADD COLUMN IF NOT EXISTS strength        TEXT NOT NULL DEFAULT 'none';
ALTER TABLE reddit_source ADD COLUMN IF NOT EXISTS category        TEXT;
ALTER TABLE reddit_source ADD COLUMN IF NOT EXISTS headline        TEXT;
ALTER TABLE reddit_source ADD COLUMN IF NOT EXISTS source_hint     TEXT;
ALTER TABLE reddit_source ADD COLUMN IF NOT EXISTS needs_expansion INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reddit_source ADD COLUMN IF NOT EXISTS fingerprint     TEXT;
CREATE INDEX IF NOT EXISTS idx_reddit_source_strength    ON reddit_source(strength);
CREATE INDEX IF NOT EXISTS idx_reddit_source_fingerprint ON reddit_source(fingerprint);
```

Field semantics:

- `strength`: `'none' | 'medium' | 'strong'`. Default `'none'` for legacy
  rows. Set by ideas importer.
- `category`: from IdeasDB `Category` column (e.g. "Medical Shocking").
  Nullable for legacy rows.
- `headline`: curated angle from IdeasDB. Distinct from `title` (Reddit's
  original post title — kept untouched on matched rows).
- `source_hint`: raw Source string from IdeasDB (multi-token form
  preserved). Useful for forensics. Nullable.
- `needs_expansion`: 1 = worker must run `expand_seed_to_post` before
  the main stages. Default 0. Idea-only seeds start at 1; matched seeds
  stay at 0. Flipped to 1 on substantial headline edits.
- `fingerprint`: lowercased+collapsed `headline + '|' + category`,
  populated whenever the importer touches a row. Used as the
  secondary match key.

### Idea-only seeds use placeholder values in the legacy NOT NULL columns

For an idea row whose Source doesn't match any existing `reddit_id`:

| column         | value                              |
|----------------|------------------------------------|
| `reddit_id`    | synthetic `idea_<sha1(headline+source_hint)[:12]>` |
| `subreddit`    | `'curated'`                        |
| `date_written` | import timestamp (ISO-8601)        |
| `title`        | headline                           |
| `full_text`    | `''` (empty; worker treats this + `needs_expansion=1` as the dispatch signal) |
| `comments`     | `NULL`                             |
| `url`          | `NULL`                             |
| `summary`      | IdeasDB summary                    |
| `length_chars` | `len(summary)`                     |
| `status`       | `'imported'`                       |
| `headline`     | IdeasDB headline                   |
| `category`     | IdeasDB category                   |
| `source_hint`  | raw Source string                  |
| `strength`     | mapped from IdeasDB Strength       |
| `needs_expansion` | `1`                             |

Why the synthetic `reddit_id` includes `source_hint`: if Yoav lightly edits
the headline of a sourceless idea, the new fingerprint catches it via the
secondary match key; if he replaces the headline entirely, that becomes
a new seed (acceptable for v1 — he can manually skip the dup if it
matters).

### New `ideas_import_log` table

```sql
CREATE TABLE IF NOT EXISTS ideas_import_log (
    run_id              TEXT PRIMARY KEY,
    started_at          TEXT NOT NULL,
    finished_at         TEXT,
    csv_path            TEXT,
    dry_run             INTEGER NOT NULL,
    rows_total          INTEGER NOT NULL DEFAULT 0,
    rows_skipped_list   INTEGER NOT NULL DEFAULT 0,
    rows_skipped_done   INTEGER NOT NULL DEFAULT 0,
    rows_added          INTEGER NOT NULL DEFAULT 0,
    rows_updated        INTEGER NOT NULL DEFAULT 0,
    rows_strength_only  INTEGER NOT NULL DEFAULT 0,
    rows_status_changed INTEGER NOT NULL DEFAULT 0,
    rows_unchanged      INTEGER NOT NULL DEFAULT 0,
    rows_warned         INTEGER NOT NULL DEFAULT 0,
    seeds_vanished      INTEGER NOT NULL DEFAULT 0,
    notes               TEXT,
    diff_json           TEXT
);
```

`diff_json` is a compact JSON array of `{reddit_id, action, before, after, warnings}`
entries, gzipped/base64 if it gets big. Capped at ~1 MB; truncated
otherwise with a `notes` warning.

### `story_jobs` — no new columns

The council's call: **do not** denormalize priority onto `story_jobs`.
The claim query JOINs `reddit_source` and reads `strength` live.
Worker claim rate is ~1/minute; the join cost is zero, and stale-write
bugs are real.

## Merge contract — the four cases

The council unanimously caught that my first plan never specified
re-import semantics. Locked here so future-me can't drift:

1. **Strength change** (`Strong` ↔ `Medium`): update
   `reddit_source.strength`. Worker JOINs live, so already-queued jobs
   reorder on the next claim. No re-enqueue needed.
2. **Row vanished from Sheet** (seed exists with non-null `source_hint`
   but no matching row in this import): **no-op**. Sheet is a working
   doc; deletions there don't authorize destructive action here.
   Surface in dry-run diff as `seeds_vanished` count so Yoav can
   investigate.
3. **Headline edited** (same match key): update `headline`, `summary`,
   `category`, `fingerprint`. If seed was already LLM-expanded
   (`full_text != ''` AND seed was idea-only) AND the headline changed
   substantially (Levenshtein ratio > 0.30), set `needs_expansion=1`
   so the next worker pass regenerates the post. Otherwise leave
   existing expansion intact.
4. **`Done=Yes` flipped on**: if seed.status not in (`used`,
   `processing`), set status `skipped`. If in (`used`, `processing`),
   no-op (already shipped or in flight). **Flipped off**: if status
   `skipped`, restore to `imported`. Otherwise no-op. Fully reversible.

Status conflict on a fresh match (Source matches an existing seed
already in `used`/`skipped`): update strength, leave status alone,
surface in diff with a warning. Yoav can decide to reset by hand.

## Worker change — JOIN, don't denormalize

[pipeline/store.py:3043](pipeline/store.py#L3043) — `claim_next_story_job`:

Today:

```sql
SELECT id FROM story_jobs
WHERE status = 'queued'
ORDER BY requested_at ASC
LIMIT 1 FOR UPDATE SKIP LOCKED
```

Becomes:

```sql
SELECT sj.id
FROM   story_jobs sj
LEFT JOIN reddit_source rs ON rs.reddit_id = sj.reddit_id
WHERE  sj.status = 'queued'
ORDER  BY CASE rs.strength
            WHEN 'strong' THEN 2
            WHEN 'medium' THEN 1
            ELSE 0
          END DESC,
          sj.requested_at ASC
LIMIT  1 FOR UPDATE SKIP LOCKED
```

Same shape for the SQLite branch (conditional UPDATE-by-id). `LEFT JOIN`
because legacy rows without an ideas-import-touched `strength` get the
default `'none'` via the column default — the JOIN is just for the
ORDER BY weight.

[pipeline/story_jobs_worker.py:174](pipeline/story_jobs_worker.py#L174) —
`reddit_source_to_post`: if `row['full_text'] == ''` AND
`row['needs_expansion'] == 1`, dispatch into `expand_seed_to_post(row)`
before the existing return. The expanded post overwrites `full_text`
in-place on `reddit_source`, flips `needs_expansion=0`, and the rest
of the stages run unchanged.

## LLM expansion stage

`pipeline/stages.py` (new function `expand_seed_to_post`):

Inputs: `headline`, `summary`, `category`, `strength`.
Output: a synthesized post body in the same shape Reddit posts produce
— `selftext`-style markdown that the existing `make_idea` / research /
article stages can consume. Persists to `reddit_source.full_text`,
flips `needs_expansion=0`.

Model selection (rule 17 — neutral, no Anthropic bias): before wiring,
check models.dev for current pricing on candidates that can synthesize
~1000-token posts from a 1-2 sentence headline + summary. Front-runners
based on training intuition but to be verified live:

- Claude Haiku 4.5 (Anthropic)
- Gemini 2.5 Flash (Google)
- DeepSeek V3.x (DeepSeek)
- GPT-5 nano / mini (OpenAI)

Decision criterion: cheapest model that produces a body indistinguishable
from a "real" reddit post in 20-sample A/B. The stage is not
reasoning-heavy — it's a structured rewrite. Cost matters here at
~2000 calls; quality must be sufficient, not maximal.

**Cost honesty:** the previous plan promised $20-60. The council
correctly tore that down — it conflated expansion cost with total
per-article cost. Real number requires:

1. Verified expansion model + token count → per-call cost.
2. Verified total stages cost per article (existing reddit-source
   articles already have a number — check ops logs or run 5 fresh
   ones with cost instrumentation).
3. Multiply by the count of seeds that *actually* need expansion
   (probably far less than 2000 once the matches land).

I'll bring back a real number before the model is wired in. Yoav
already said don't defer expansion — fine, expansion ships in v1,
but the cost gets verified before the model name lands in code.

## CLI importer

`scripts/import_ideas.py` (Python — same place the existing pipeline
lives, no Vercel dependency, no timeout):

```
python scripts/import_ideas.py path/to/ideas.csv          # dry-run, prints diff
python scripts/import_ideas.py path/to/ideas.csv --apply  # commits + writes log
python scripts/import_ideas.py path/to/ideas.csv --apply --quiet  # no diff print
```

Phases:

1. Parse CSV with `csv.DictReader`. Required headers:
   `Category, Type, Headline, Summary, Source, Strength, Done Already?`.
   Missing header → hard fail.
2. Filter: drop `Type != 'Story'` (count in `rows_skipped_list`),
   drop `Done Already? lower == 'yes'` (count in `rows_skipped_done`).
3. Normalize each surviving row → `IdeaRow(headline, summary, category,
   source_tokens: list[str], strength, fingerprint)`.
4. Resolve match keys (single SQL query per token batch, not per-row).
5. Compute diff vs. current DB state for each row.
6. If `--apply`: open a transaction, apply all updates, insert new
   seeds, write log row. Else: just print the diff.
7. Print summary: counts + sample warnings + log row ID.

Concurrency: single-process, single-transaction. 2000 rows of UPSERT
inside one transaction is fine for SQLite (well under the WAL
threshold) and trivial for Postgres.

## Admin UI scope

**v1 (this PR):**

- Strength badge column on the existing Reddit Sources table at
  [src/app/admin/(panel)/reddit-sources/page.tsx](lorewire-app/src/app/admin/(panel)/reddit-sources/page.tsx).
- Filter dropdown for strength (`any / strong / medium / none`).
- Sort: default sort respects strength DESC then `last_synced` DESC.
- Show `category` + `headline` (idea angle) when present, in a
  collapsed-by-default subrow under the existing title.

**v2 (separate PR):**

- Admin "Import Ideas" button (web wrapper around the CLI).
- Audit log viewer for `ideas_import_log`.
- "Reset to imported" bulk action on `used`/`skipped` rows with priority.

**Deferred / probably never:**

- Separate `/admin/ideas` tab. The Outsider's nouns-are-a-maze critique
  is real — one table, one admin surface. Strength is the sort signal,
  not a separate page.
- Embeddings, `kind=trend`, regenerate-angle, engagement feedback loops.
  Defensible later; out of scope now.

## Testing (rule 18)

Unit tests (Python, pytest):

- `parse_ideas_csv`: golden 9-row fixture (`tests/fixtures/ideas_sample.csv`)
  covering Story+match, Story+no-match, Story+multi-token,
  Story+garbage Source, List (filtered), Done=Yes (filtered),
  blank Strength, headline with quotes/commas, empty CSV.
- `resolve_match_key`: each branch (direct reddit_id hit, fingerprint
  hit, miss).
- `compute_diff`: each of the four merge-contract cases + status
  conflict + Done flip-flop.
- `apply_diff` (DB-level, in-memory SQLite): commits expected state,
  log row content, idempotency on second run.
- `claim_next_story_job`: 3-seed fixture (strong / medium / none),
  3-job fixture, assert claim order strong → medium → none, FIFO
  within tier.
- `expand_seed_to_post`: shape test (returns a non-empty selftext;
  doesn't crash on minimal input). Real LLM call gated behind
  `RUN_LIVE_LLM_TESTS=1` env var.

Integration tests (Node, vitest):

- Existing reddit CSV importer regression: re-run the existing
  test suite, assert no behavior change.
- Admin page renders strength badge + filter.

Snapshot test:

- Dry-run diff JSON shape against the 9-row fixture — locks the
  observable contract.

## Observability (rule 14)

Python-side namespaces:

- `[seeds-import csv-parse]`: headers detected, rows parsed,
  rows filtered (with reasons), warnings.
- `[seeds-import match]`: per-token hit / miss, fingerprint matches.
- `[seeds-import diff]`: per-row action with before/after for the
  changed fields.
- `[seeds-import apply]`: counts as the transaction commits.
- `[seeds-import log]`: log row ID + summary.
- `[seeds-worker claim]`: claimed job ID, reddit_id, strength.
- `[seeds-worker expand]`: model used, prompt token count, response
  token count, latency, cost (if instrumented).

TS-side (when v2 admin button lands):

- `[seeds-admin import-action]`: file size, run mode, log row ID.

Every log includes actual values, not just event names — per the rule:
"booleans without values give nothing to diagnose."

## Security (rule 13)

- CLI is local-only — no web exposure in v1.
- v2 admin button must reuse existing `requireAdmin` guard.
- CSV size limit: 10 MB hard cap (2000 rows fits in ~1 MB).
- No SQL injection vector: all DB calls are parameterized via
  `store.py`'s existing wrappers.
- `strength` and `status` enum values validated against an allowlist
  before any DB write.
- `synthetic_reddit_id`: SHA-1 collision risk at 2000 rows / 48 bits
  ≈ 1 in 35 million. Acceptable.
- `ideas_import_log.diff_json` contains user content (headlines,
  summaries). Not PII per se, but treat as sensitive: log row owner =
  importer's user ID; never expose via public route.
- LLM expansion: no Yoav-private data leaves the system besides the
  IdeasDB content (already curated public-ish content).

## Settings (rule 15)

Nothing new in v1 — the only knob worth exposing later is "default
expansion model," and the right time to add that is when v2 admin
button ships with a model-picker that touches multiple stages, not
this one.

## What gets cut vs. the original plan

Council teardown of original v0 plan:

- ❌ Separate `story_idea` table → ✅ single `reddit_source` table
  with nullable idea columns.
- ❌ `story_jobs.kind` discriminator → ✅ dispatch on
  `needs_expansion` flag inside `reddit_source_to_post`.
- ❌ Denormalized `story_jobs.priority` → ✅ JOIN on claim, read
  strength live.
- ❌ `sha1(headline)[:12]` PK on an `idea_` table → ✅ no separate
  table; synthetic `idea_<sha1(headline + source_hint)[:12]>`
  `reddit_id` for idea-only seeds is fine because it's only
  generated once and matched-or-fingerprinted on re-import.
- ❌ Multi-token Source: "take first, warn on rest" → ✅ fan out
  to all tokens.
- ❌ 2000-row HTTP upload → ✅ CLI in v1.
- ❌ Vague $20-60 cost claim → ✅ verify model + token count + match
  rate before committing.
- ❌ No re-import contract → ✅ four-case merge contract above.
- ❌ Separate `/admin/ideas` tab → ✅ strength badge on existing
  Reddit Sources page.

Per Yoav's explicit override, **kept** in v1:

- ✅ LLM expansion stage in this PR (don't defer until 20 ideas
  run end-to-end — Yoav wants the priority backlog draining now).

## Open questions / followups

- Verify expansion model pricing on models.dev before wiring. Bring
  Yoav the real per-article cost before committing.
- v2 admin "Import Ideas" button: separate PR, separate plan.
- After 100 ideas have gone end-to-end, look at the output and decide
  whether E's "regenerate angle" play is worth building.
- If Yoav adds a stable per-row UUID column to the Sheet later,
  switch the match key to that and retire the fingerprint heuristic.

## Council verdict (summary)

5-advisor council ran 2026-06-23. Verdict captured in chat transcript.
Key shifts from v0:

- 4/5 picked First Principles' single-table collapse as strongest.
- 4/5 flagged Expansionist's content-engine roadmap as the most
  dangerous (premature scope on a broken foundation).
- 5/5 caught the same blind spot: idempotency / re-import contract
  was unspecified.
- Contrarian's four landmines (denormalized priority, sha1 PK on
  user-edited text, silent multi-token drop, fantasy cost estimate)
  are all addressed above.
- Executor's CLI-first + verify-cost-with-20-samples discipline
  adopted, except for Yoav's expansion-deferral override.
- Outsider's "priority means two things" + "no dry-run preview"
  caught the UX traps. Resolved by keeping the single column name
  `strength` on `reddit_source` (no separate `queue_priority` —
  worker computes the weight inline) and making dry-run the
  default CLI mode.
