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

## Phase 7 — Daily-budget cap that aborts in-flight worker batches

**Why:** This is the highest-risk gap. At ~$0.30–0.50 per row (LLM + kie + voice), an accidental "Process 500" or a runaway worker is real money. Today the only guard is the confirm dialog. A budget cap that aborts mid-batch turns a potential $250 mistake into a $25 mistake.

**Scope:**
- New setting key `budget.daily_usd_cap` in the existing `settings` table; default unset (no cap). Setting UI surface lives in `/admin/settings`.
- New helper in `pipeline/store.py:today_spend_cents()` — sums `stories.cost_cents` for stories whose `created_at` is in the current UTC day. (We already write `cost_cents` per story; this is a pure read.)
- Update `pipeline/story_jobs_worker.py:run_one_tick` — before claiming, check `today_spend_cents() + ESTIMATED_COST_CENTS >= cap_cents`. If yes, log `[story-jobs budget-block] today=$X cap=$Y` and sleep instead of claiming. The in-flight job that triggered the breach finishes normally; the next tick is blocked.
- New TS read helper `getTodayStorySpend()` in `@/lib/repo` or a new `@/lib/budget.ts`.
- Admin UI: small "Today's spend: $X / $Y cap" line on `/admin/reddit-sources` and on `/admin` overview. Reuses the same `stories.cost_cents` data already collected.
- Settings page: a single number input + save action for `budget.daily_usd_cap`. Validation: must be ≥ 0, blank = unlimited.
- Tests:
  - `today_spend_cents()` correctly sums by UTC day (boundary case: a story created at 23:59 UTC yesterday isn't counted).
  - Worker tick is blocked when projected spend exceeds cap.
  - Worker tick proceeds when cap is unset or projected spend is below.

**Open question:** What is `ESTIMATED_COST_CENTS`? A flat default (say $0.50) is too conservative for small text-only runs and too generous for high-scene runs. Options:
1. Static $0.50 — simple, conservative.
2. Settings-driven `budget.estimated_cost_cents_per_story` — admin-tunable.
3. Sliding window: average of last 10 stories' actual `cost_cents`. Adaptive but harder to reason about.

Recommendation: ship #1 first (simplest, no settings round trip), add #2 when the user feels the cap kick in at a bad threshold.

**Time estimate:** ~2–3 hours.

---

## Phase 8 — Vercel drain endpoint for `story_jobs`

**Why:** Today the worker is a long-running local Python process. For a production deploy where the user isn't running anything locally, the queue would just stall. Mirroring the existing [api/drain_image_renders.py](lorewire-app/api/drain_image_renders.py) pattern lets a Vercel cron drain the story_jobs queue.

**Scope:**
- New `lorewire-app/api/drain_story_jobs.py` (or `.ts`, depending on which the existing drain uses — confirm by reading the file first).
- Wraps `pipeline.story_jobs_worker.run_one_tick` in the existing `image_render_drain_lock` advisory-lock pattern (or its `story_jobs` sibling, see below).
- Add `STORY_JOBS_DRAIN_LOCK_KEY` constant in [pipeline/store.py](pipeline/store.py) and a `story_jobs_drain_lock()` helper, mirroring `IMAGE_RENDER_DRAIN_LOCK_KEY` / `image_render_drain_lock()` exactly.
- `vercel.json` cron entry to hit the drain endpoint (existing pattern in the file).
- Test: parity with the existing drain-handler test pattern (`pipeline/tests/test_drain_image_renders.py` is the template).

**Pre-work:** Read [pipeline/image_render_worker.py](pipeline/image_render_worker.py) and [api/drain_image_renders.py](lorewire-app/api/drain_image_renders.py) to confirm the exact pattern. They're the canonical reference.

**Production cost:** Vercel cron is free at this rate (one tick / minute, ~720/day). Cron + advisory lock + the early-exit short-circuit in `count_pending_story_jobs()` means an idle tick bills near zero on Active CPU.

**Caveat:** Worker runs the full `media.generate_media` + `video.generate_video` paths. The latter shells out to Remotion via npx; that won't work on Vercel's runtime without a separate render host. If `--no-media` is the default for the drain, this becomes useful for text-only candidate-pool work; full media + video stays on the local worker for now. Worth flagging at the top of the implementation.

**Time estimate:** ~3 hours.

---

## Recommended sequence

1. **Phase 5** (30 min) — closes a known concurrency hole in code that's about to see real use. Smallest possible win.
2. **Phase 6** (1 hr) — completes the bulk-action UX so the candidate list isn't half-curated, half-per-row.
3. **Phase 7** (2–3 hr) — biggest real-money protection. Do before any batch larger than ~10 rows hits the worker.
4. **Phase 8** (3 hr) — only needed once you actually deploy and want the queue drained without a local worker. Defer until that day.

Each phase passes the same gates as the parent plan: tests, namespaced logs, lint, typecheck, no destructive auto-actions.
