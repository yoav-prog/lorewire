# Reddit DB sync — production hardening follow-ups

**Status:** open — pickable in any order, each phase is independent and self-contained
**Owner:** Yoav (info@flexelent.com)
**Date:** 2026-06-14
**Parent plan:** [_plans/2026-06-14-reddit-db-sync.md](_plans/2026-06-14-reddit-db-sync.md) (Phases 1–4 shipped)

## Why this exists

The four-phase Reddit DB sync ships end-to-end: import → review → publish. The plan deliberately deferred four hardening items so the core loop could land first. This file picks them up as Phases 5–8 so any of them can be opened in a fresh session with full context.

Phases here are **independent** — you can ship 5, then jump to 7, etc. They share no data shape changes that would force an order. Recommended sequence is below, but only because of how much value each unlocks for the next; pick whichever bites first.

---

## Phase 5 — Partial unique index on `story_jobs` (shipped 2026-06-14)

**Why:** Today's idempotency check in [pipeline/store.py:has_active_story_job](pipeline/store.py) is application-level. A simultaneous double-click on Process N can in principle slip past the check-then-insert window and enqueue two jobs for the same `reddit_id`, doubling the LLM + image spend on that row. The fix is a partial unique index that lets the DB itself enforce "at most one active job per reddit_id."

**Shipped:**
- ✅ Partial unique index `idx_story_jobs_one_active ON story_jobs(reddit_id) WHERE status IN ('queued', 'processing')` added to [pipeline/store.py](pipeline/store.py) SCHEMA_STATEMENTS. Identical syntax on SQLite ≥ 3.8 and Postgres ≥ 9.5.
- ✅ `pipeline/store.py:enqueue_story_job` switched to `INSERT ... ON CONFLICT (reddit_id) WHERE status IN ('queued', 'processing') DO NOTHING` with `cur.rowcount` check to detect the race-loss → return `None` cleanly. App-level `has_active_story_job` check kept as the fast path.
- ✅ `lorewire-app/src/lib/story-jobs.ts:bulkInsertJobs` mirrors the same ON CONFLICT clause so a race-losing batch INSERT silently skips the loser instead of throwing UNIQUE and aborting the whole batch.
- ✅ TS schema mirror gap closed: new `POST_TABLE_DDL` array in [lorewire-app/src/lib/schema.ts](lorewire-app/src/lib/schema.ts) holding load-bearing index DDL, run by [lorewire-app/src/lib/db.ts](lorewire-app/src/lib/db.ts) `ensureSchema` after the per-table loop. This is the seam future indexes that TS write paths depend on should land in.
- ✅ Tests: 3 Python tests (`PartialUniqueIndexTests`) in [pipeline/tests/test_story_jobs.py](pipeline/tests/test_story_jobs.py) covering raw-duplicate-insert rejection, done/error settling allowing fresh active rows, and helper-level race-loss returning None. 3 TS tests in [lorewire-app/src/lib/story-jobs.test.ts](lorewire-app/src/lib/story-jobs.test.ts) `partial unique index` describe block covering the same three scenarios end-to-end.
- ✅ Suite: 59 Python tests + 30 TS tests green, zero typecheck regressions.

**Migration risk:** Confirmed zero — the existing app-level guard means no current rows violate the partial index. `CREATE UNIQUE INDEX IF NOT EXISTS` is idempotent on both engines.

---

## Phase 6 — Bulk re-process from the candidate list (shipped 2026-06-14)

**Why:** Today the only way to re-process a row is to open its review page and click Re-process. If the LLM rewrote 20 stories poorly in one batch, you have to visit 20 pages. A bulk action mirrors the existing Skip and Process N in the list footer.

**Shipped:**
- ✅ Helper `bulkReprocessRedditSources(redditIds)` in [lorewire-app/src/lib/reddit-source.ts](lorewire-app/src/lib/reddit-source.ts) — snapshot-then-loop. Returns `{reset, skipped_active, skipped_other, not_found, reset_ids}` so the admin sees exactly what happened.
- ✅ Conservative semantics for the bulk path (different from the per-row review-page action): only `status='used'` rows get reset. `queued` / `processing` are skipped to avoid disrupting an in-flight worker. `imported` / `skipped` are no-ops. The per-row review-page action stays permissive (the admin is being deliberate there).
- ✅ Server action `bulkReprocessRedditSourcesAction` in [actions.ts](lorewire-app/src/app/admin/actions.ts) with the same auth → log → revalidate → redirect-with-counts shape as Phase 3's `processRedditSourcesAction`.
- ✅ Bulk footer button in [RedditSourceTable.tsx](lorewire-app/src/app/admin/(panel)/reddit-sources/RedditSourceTable.tsx) with confirm dialog that explicitly names the "skipped if active" behaviour so a surprise mid-worker click isn't possible.
- ✅ Flash-banner component on the browse page surfacing `?reset=N&skipped_active=M` (also handles `?enqueued=N&skipped_active=M` from Process N — the two flows now share the same banner shape).
- ✅ Tests: 5 new TS tests in [story-jobs.test.ts](lorewire-app/src/lib/story-jobs.test.ts) `bulkReprocessRedditSources` describe block — empty input, single-used reset, mixed-batch partitioning (used / queued / imported / not-found in one call), orphan defensiveness (used row with no story_id), idempotency on double-click. Suite total: 35 TS tests + 59 Python tests, all green.

**Time taken:** ~45 minutes (under the estimate; the test-fixture seeding helpers carried over from earlier phases).

---

## Phase 7 — Daily-budget cap that aborts in-flight worker batches (shipped 2026-06-14)

**Why:** This is the highest-risk gap. At ~$0.30–0.50 per row (LLM + kie + voice), an accidental "Process 500" or a runaway worker is real money. Today the only guard is the confirm dialog. A budget cap that aborts mid-batch turns a potential $250 mistake into a $25 mistake.

**Pragmatic deviation from the original plan:** the worker doesn't actually populate `stories.cost_cents` today (writes tokens only). So summing that column would always read $0 and the cap would never bite. Shipped instead with a count-based estimate: `(done_today + active_jobs) × $0.50`. Honest in its imprecision, accurate enough to be a safety net. Real per-story cost capture is a separate micro-phase.

**Shipped:**
- ✅ Setting key `pipeline.story_jobs.daily_cap_cents` (integer cents — explicit unit, no float round-tripping). Blank / 0 / negative / non-numeric = no cap (admin "off" beats "broken setting halts everything").
- ✅ `pipeline/store.py:today_story_job_estimate_cents(estimate_per_job)` — counts done-today (UTC) + active jobs from the `story_jobs` table; multiplies by the per-job estimate. ISO-timestamp range compare on TEXT column — portable across SQLite + Postgres.
- ✅ `pipeline/story_jobs_worker.py` constant `ESTIMATED_JOB_COST_CENTS = 50` and `_budget_block_reason()` helper. `run_one_tick` calls it BEFORE `claim_next_story_job` so a blocked tick doesn't waste a claim/finish cycle. Log line: `[story-jobs budget-block] projected=Xc + next~Yc > cap=Zc`.
- ✅ TS module [lorewire-app/src/lib/story-jobs-budget.ts](lorewire-app/src/lib/story-jobs-budget.ts) — `getDailyBudgetCapCents`, `getTodayStoryJobsEstimate`, `getBudgetSummary` (one-stop for the admin UI), `formatCents`. The TS `ESTIMATED_JOB_COST_CENTS` is documented to stay in sync with the Python constant; a parity test asserts the value.
- ✅ Server action `setDailyBudgetCapAction` in [actions.ts](lorewire-app/src/app/admin/actions.ts) — admin enters dollars; we normalize to cents and store as integer. Empty input clears the cap.
- ✅ Budget bar at the top of [/admin/reddit-sources](lorewire-app/src/app/admin/(panel)/reddit-sources/page.tsx). Three visual states: muted (under 75%), amber (75%+), red (next job would block). Inline cap form. Sub-line shows `N jobs (done today + active) · est. ~$0.50/job` so the admin sees what's being counted.
- ✅ Tests:
  - 6 Python tests in `BudgetGateTests` (no-cap, corrupt-cap-treated-as-unset, block when over, proceed when under, estimate includes done-today + active not ancient, zero-estimate empty queue).
  - 12 TS tests in `story-jobs-budget.test.ts` (cap getter, today estimate counting, summary fraction/exhausted/no-cap, parity constant, formatter).
- ✅ Suite: **89 Python + 47 TS = 136 tests green.**

**Open follow-up:** the real-cost-capture micro-phase. Wire `images.totals` / `voice.totals` / LLM token counts to a single `cost_cents` write at the end of `_default_process` so the budget bar can show actual rather than estimated spend.

---

## Phase 8 — Vercel drain endpoint for `story_jobs` (shipped 2026-06-14)

**Why:** Today the worker is a long-running local Python process. For a production deploy where the user isn't running anything locally, the queue would just stall. Mirroring the existing [api/drain_image_renders.py](lorewire-app/api/drain_image_renders.py) pattern lets a Vercel cron drain the story_jobs queue.

**Shipped:**
- ✅ `STORY_JOBS_DRAIN_LOCK_KEY = 8472302` (distinct from image_renders' key so the two drains don't contend) + `story_jobs_drain_lock()` helper in [pipeline/store.py](pipeline/store.py). Reuses the existing `_AdvisoryLock` class.
- ✅ [lorewire-app/api/drain_story_jobs.py](lorewire-app/api/drain_story_jobs.py) — the same auth + advisory-lock + per-tick budget + structured-log shape as the image_renders drain. Implementation is smaller because it composes `story_jobs_worker.run_one_tick` (which already does its own stale-claim reap + budget-gate check) instead of replicating the claim loop.
- ✅ [vercel.json](lorewire-app/vercel.json): cron `*/2 * * * *` for drain_story_jobs (every 2 min — story_jobs are heavier per-row than image_renders so we halve the cadence), maxDuration 300s. Image_renders drain unchanged.
- ✅ 13 tests in [pipeline/tests/test_drain_story_jobs.py](pipeline/tests/test_drain_story_jobs.py): auth (4), max-rows env (4), drain happy/fail/cap/budget-block/idle (5). Suite: **85 Python tests green**, including the image_renders drain tests confirming no regression from the new lock key.

**Runtime limitation (closed 2026-06-14 by the drain pre-skip follow-up below):** `story_jobs_worker._default_process` calls `video.generate_video` for `with_media=True` jobs, which shells out to Remotion via `npx`. That doesn't work on Vercel's runtime. As of the drain pre-skip ship, the drain passes `skip_with_media=True` to `run_one_tick`, so any claimed video job is failed at claim time with `DRAIN_UNSUPPORTED_MEDIA_REASON` (no LLM/image spend) and its source row resets to 'imported' so the admin can re-Process with `with_media=False`. For full media + video, keep using the local worker.

**Production cost:** Vercel cron is free at this cadence (one tick / 2 min = ~720/day still under the free Hobby allowance). Cron + advisory lock + the early-exit short-circuit in `count_pending_story_jobs()` means an idle tick bills near zero on Active CPU.

---

## Recommended sequence

1. **Phase 5** (30 min) — closes a known concurrency hole in code that's about to see real use. Smallest possible win.
2. **Phase 6** (1 hr) — completes the bulk-action UX so the candidate list isn't half-curated, half-per-row.
3. **Phase 7** (2–3 hr) — biggest real-money protection. Do before any batch larger than ~10 rows hits the worker.
4. **Phase 8** (3 hr) — only needed once you actually deploy and want the queue drained without a local worker. Defer until that day.

Each phase passes the same gates as the parent plan: tests, namespaced logs, lint, typecheck, no destructive auto-actions.

---

## Micro-phase — Real cost capture (shipped 2026-06-14)

**Why:** Phase 7 ships with a count-based estimate ($0.50/job) because the worker wasn't populating `stories.cost_cents`. The budget bar showed projection only. This wires the existing cost model in `pipeline/media.py` — already used by `_log_budget_remaining` and `_story_cost_cents` — into the story_jobs worker so the column gets real numbers, and surfaces those numbers in the bar.

**Shipped:**
- ✅ `media.running_cost_usd()` — public wrapper over the existing private `_running_cost_usd()` so callers outside `media.py` can snapshot before/after a single pipeline run.
- ✅ `story_jobs_worker._default_process` snapshots `media.running_cost_usd()` at the top and writes `row["cost_cents"] = round((after - before) * 100)` before `upsert_story`. Rounded, clamped at 0. This is now persisted on every run.
- ✅ `pipeline/store.py:today_actual_story_cost_cents()` — SUMs `stories.cost_cents` for today (UTC), excluding NULL rows so older pre-capture stories don't poison the average.
- ✅ TS mirror `getTodayActualSpendCents()` in [story-jobs-budget.ts](lorewire-app/src/lib/story-jobs-budget.ts), added to `BudgetSummary.actualCents`. Subtle green pill on the budget bar shows `actual $X` when nonzero — sits beside the count-based projection so the admin sees both numbers.
- ✅ The worker budget gate **still uses the count-based estimate**, not actual. Rationale: the gate is a pre-claim safety net that has to project the *next* job's cost — actual data lags by one job. Using estimate at the gate is conservative-by-design; actual is for reporting.
- ✅ Tests: 4 new Python tests in `ActualCostTests` (zero baseline, today sum, exclude-other-days, exclude-NULL) + 5 new TS tests in `story-jobs-budget.test.ts` (`getTodayActualSpendCents` direct + `BudgetSummary.actualCents` integration). Suite total: **98 Python + 47 TS = 145 tests green.**

**Pricing source:** `pipeline/media.py` already had `IMAGE_COST_USD`, `TTS_COST_PER_CHAR`, `STT_COST_PER_SECOND` tables sourced from each provider's public pricing as of 2026-06. Per CLAUDE.md rule 8 + 1, these should be re-verified every few months — the constants are clearly grouped at the top of [pipeline/media.py](pipeline/media.py) for that purpose.

**Not in scope:** LLM token cost (not in `_running_cost_usd`'s current model). It's a rounding error vs images + voice (~$0.05 per story vs $0.30+ for images), but adding it is a clean follow-up if precision matters more than the writeup says.

> **Update 2026-06-14:** LLM cost capture _was_ added in commit `427b219` ("Story jobs: harden cost capture, race handling, and CSV parser"). New constant `LLM_USD_PER_TOKEN = 1e-6` in [pipeline/story_jobs_worker.py](pipeline/story_jobs_worker.py), pure helper `compute_job_cost_cents(media_delta_usd, llm_token_delta)` so the math has unit tests. `_default_process` now snapshots `llm.totals["total_tokens"]` before/after the run alongside `media.running_cost_usd()` and writes the combined delta into `stories.cost_cents`. Text-only jobs no longer report cost_cents=0.

---

## Micro-phase — Drain pre-skip for `with_media=True` jobs (shipped 2026-06-14)

**Why:** Phase 8 shipped the Vercel drain with a documented gap — `with_media=True` jobs claimed by the hosted drain still ran the LLM + image stages, then crashed at `npx remotion` (Vercel's Python runtime has no Node or Remotion). The job ended errored with ~$0.30+ already spent on a row that was never going to finish. The drain's docstring called this out as a future enhancement; this micro-phase closes it.

**Shipped:**
- ✅ Module-level constant `DRAIN_UNSUPPORTED_MEDIA_REASON` in [pipeline/story_jobs_worker.py](pipeline/story_jobs_worker.py) — the exact `story_jobs.error` message recorded on a pre-skipped row. Stable string so the admin UI and future test fixtures can match against it.
- ✅ `run_one_tick(process_fn=None, skip_with_media=False)` — new opt-in flag. When True, a claimed job whose `with_media=True` is failed immediately (no `fetch_reddit_source`, no `process_fn` call) with `DRAIN_UNSUPPORTED_MEDIA_REASON`. Default False so the local CLI worker keeps processing video jobs unchanged.
- ✅ Source row resets to `imported` (not `queued` like the regular error path) so `bulkEnqueueStoryJobs`'s `status='imported'` guard lets the admin re-Process the row with `with_media=False` and the drain handles it next tick. Documented in-line because the choice diverges from the existing error path on purpose.
- ✅ Drain handler [lorewire-app/api/drain_story_jobs.py](lorewire-app/api/drain_story_jobs.py) passes `skip_with_media=True` to `run_one_tick`. Docstring rewritten — the "future enhancement" caveat is now the implemented behaviour.
- ✅ Tests:
  - 3 worker-tick tests in [test_story_jobs.py](pipeline/tests/test_story_jobs.py) `WorkerTickTests`: pre-skip path (errored + source→imported + process_fn never called), text-only opt-in still processes normally, default flag preserves local-worker semantics for video jobs.
  - 2 drain integration tests in [test_drain_story_jobs.py](pipeline/tests/test_drain_story_jobs.py) `RunDrainTests`: all-video batch (both rows errored, zero process calls — the money-saving invariant), mixed batch (video skipped + text processed, loop doesn't abort early).
  - Helper `_enqueue` default changed to `with_media=False` because the drain only processes text-only jobs end-to-end now; that's the right default for the drain test file. Existing drain tests (auth, idle, failure-continue, cap, budget-block) carried over unchanged.
- ✅ Suite: **61 Python tests in the story_jobs + drain files green** (full suite has 7 pre-existing unrelated failures in `test_segments.py` / `test_media_regen.py` that are present on HEAD without these changes).

**What this prevents:** a single accidental `with_media=True` enqueue against the production drain used to burn ~$0.30 LLM + image spend before erroring out at video. Now the same row errors within milliseconds at near-zero cost, and the admin sees a precise reason on the row's latest story_job. The pre-skip path is also tagged in the logs (`[story-jobs drain-skip]`) for grep friendliness.
