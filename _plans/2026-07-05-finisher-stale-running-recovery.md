# Finisher stale-'running' recovery + enforced deadline

Date: 2026-07-05
Branch: fix/finisher-stale-running
Status: approved (Yoav: "do it", after the 1kg8vng incident diagnosis)

## Incident

Pipeline run for story 1kg8vng sat at HERO & THUMB / RUNNING for ~4 hours
with the STUCK badge on. The story and short were done; Yoav published the
story manually. Root cause: the hero+thumbnail finisher cron claimed the
job (finisher_status='running'), then the Vercel function died without
writing a terminal status. Two gaps let that happen:

1. `DEADLINE_S = 770` in api/run_hero_thumbnail_finisher.py is defined but
   never enforced. A hung kie i2i call rides into Vercel's 800s SIGKILL,
   which bypasses the except-Exception path that writes 'failed'.
2. Every other queue (story_jobs, short_renders, voice_renders,
   image_renders) has a reap_stale_* crash-recovery helper. The finisher
   lane has none, so a 'running' zombie lives until an admin clicks Stop.

A second symptom from the same screenshot: a QUEUED finisher waiting 2h is
NOT blocked by the zombie (claims only look at 'pending'); that one waits
on its own short render and is out of scope here.

## Goals

- A finisher whose function died is detected and retried automatically,
  with a hard cap so a genuinely broken job can't loop paid i2i calls.
- A hung finisher writes its own terminal outcome BEFORE the platform
  kill, with a timeline event the admin can see.
- The Live Runs page stops showing immortal RUNNING rows for dead work.

## Constraints

- Money: each finisher attempt is 5 paid i2i calls. Retries must be
  capped (house pattern: MAX_SHORT_RENDER_ATTEMPTS). Cap here: 1 revive,
  i.e. at most 2 paid attempts per job.
- The 2026-06-29 live-runs plan rejected an unattended reaper that flips
  rows "on its own". This reaper acts only on hard evidence: a claimed_at
  stamp older than 30 min (double Vercel's 800s ceiling), the exact
  pattern already trusted for story_jobs / short_renders / voice_renders.
- SQLite (dev) + Postgres (prod) parity — every store change dual-path.
- api/_lib is vendored from pipeline/ at prebuild; source of truth for
  store/worker changes is pipeline/, the cron file lives in
  lorewire-app/api/.

## Approach (chosen)

Mirror the existing reap_stale_short_renders design:

1. **Schema** (pipeline/store.py SCHEMA_STATEMENTS + TS
   src/lib/schema.ts STORY_JOBS columns):
   - `story_jobs.finisher_claimed_at TEXT` — stamped by
     claim_finisher_job, cleared on revive.
   - `story_jobs.finisher_attempts INTEGER DEFAULT 0` — revive counter;
     COALESCE(...,0) everywhere because the TS-side ADD COLUMN emits no
     DEFAULT (house convention, see short_renders.attempts).

2. **store.claim_finisher_job** stamps finisher_claimed_at=now when
   flipping pending → running (both engines).

3. **store.set_finisher_status** becomes conditional on
   `finisher_status='running'` so a late write from an orphaned thread
   (or a resumed frozen instance) can't clobber 'cancelled' / 'failed' /
   a re-claimed row. Today it would overwrite an admin's Stop.

4. **store.reap_stale_finisher_jobs(stale_after_s)** — bulk, called at
   the top of the cron tick. Acts on finisher_status='running' rows whose
   finisher_claimed_at < cutoff OR IS NULL (rows claimed before this
   deploy, e.g. the current production zombie, heal on the first tick):
   - COALESCE(finisher_attempts,0) >= MAX_FINISHER_ATTEMPTS (=1) →
     'failed' + timeline event `finisher_reaper_gave_up` (level=error).
   - else → 'pending', attempts+1, claimed_at=NULL + timeline event
     `finisher_reaper_revived` (level=warn). The normal claim query
     re-claims it (ORDER BY finished_at ASC keeps it first in line).

5. **store.requeue_or_fail_timed_out_finisher(job_id)** — single-row
   variant used by the in-process timeout path; same cap decision, events
   `finisher_timeout_requeued` / `finisher_timeout_gave_up`. Conditional
   on the row still being 'running' (admin may have cancelled mid-flight).

6. **api/run_hero_thumbnail_finisher.py**:
   - `FINISHER_STALE_S = 1800` (mirrors RENDERING_STALE_S; well above the
     800s ceiling so a slow-but-live finisher is never reaped out from
     under itself).
   - run_drain: reap first (log count), then claim as today.
   - Enforce DEADLINE_S: run run_finisher_for_job on a worker thread,
     `future.result(timeout=DEADLINE_S - elapsed)`. On timeout: log,
     write timeline event, requeue_or_fail, return 200 with
     `{timed_out: true, outcome}`. Exceptions from the thread re-raise
     through future.result, preserving the existing fatal path.

7. **TS read side** (src/lib/runs.ts): SELECT finisher_claimed_at and use
   it as startedAt for finisher runs (the comment there says "no
   dedicated finisher timestamp" — now there is one). No UI component
   changes: computeHeroStage already renders 'failed', and a revived row
   is just 'pending' again.

## Alternatives rejected

- **Fail-only reaper (no retry).** Safest for spend but wrong default:
  the common cause is a one-off hang/kill, and a single automatic retry
  is exactly what the short_renders reaper already does. Cap of 1 revive
  bounds worst-case spend at 2 attempts.
- **Reclaim stale rows inside claim_finisher_job's WHERE.** Fewer moving
  parts but silent — no timeline event, no attempts cap, and it hides
  recovery inside a query nobody reads. House pattern is an explicit
  reaper.
- **Timeout leaves row 'running' for the reaper.** Simpler cron change,
  but recovery then always waits the full 30 min and the admin watches a
  known-dead run. The single-row helper acts immediately.

## Security

No new inputs, no new endpoints, no auth changes. The cron stays behind
CRON_SECRET Bearer auth. The reaper only narrows what a wedged row can
do (it can no longer hold 'running' forever), and the conditional
terminal write closes a write-after-cancel hole. Nothing sensitive is
logged: events carry job ids, attempt counts, and elapsed seconds.

## Observability

- Cron structured logs: `reaped` count per tick, `timeout` with elapsed
  + deadline + outcome, existing `claimed`/`tick`/`fatal` unchanged.
- Per-row story_job_events: finisher_reaper_revived (warn),
  finisher_reaper_gave_up (error), finisher_timeout_requeued (warn),
  finisher_timeout_gave_up (error) — visible on the job timeline in the
  admin, same as the short-render reaper events.

## Settings

No new user-facing settings. Thresholds (FINISHER_STALE_S, DEADLINE_S,
MAX_FINISHER_ATTEMPTS) stay code constants, matching every other queue's
reaper (GENERATING_STALE_S etc.). Exposing per-queue reaper knobs in the
admin would be a footgun with no realistic use case.

## Testing

pipeline/tests/test_finisher_reaper.py (new, _IsolatedDB pattern):
- claim stamps finisher_claimed_at.
- reap revives an old-claimed running row → pending, attempts 0→1,
  claimed_at NULL, event row written, re-claimable by claim_finisher_job.
- reap treats claimed_at IS NULL running rows as stale (pre-deploy
  zombie).
- reap leaves fresh running rows and pending/cancelled/done rows alone.
- reap gives up at the attempts cap → failed + event.
- set_finisher_status no-ops on a cancelled row (regression: orphan
  overwrite), still works running → done/failed.
- requeue_or_fail_timed_out_finisher: requeues under cap, fails at cap,
  no-ops on a non-running row.
- run_drain timeout path (import cron via sys.path like
  test_drain_story_jobs): stub run_finisher_for_job that blocks past a
  patched DEADLINE_S → row requeued, response carries timed_out.

TS: vitest for runs.ts startedAt mapping change (existing suite must stay
green). Full `pipeline` pytest suite + `npm test` before commit; main has
4 known pre-existing failures (2026-07-05 memory) — anything beyond those
is on me.

## Deploy

Standard flow: push branch, PR into main, merge deploys production.
Additive columns via the existing idempotent migration lists on both
engines; Python cron and TS app deploy together so there is no ordering
gap. Rollback = revert the merge; the columns are additive and harmless
if unused. No env var changes, no Vercel settings touched.

## Open questions

- None blocking. The QUEUED-for-2h STERILIZATION FIGHT finisher waits on
  its short render; if that short is itself a zombie the short reaper
  story is separate and already exists.
