# Re-screen the held backlog with the current safety judge

Date: 2026-07-19
Branch: `feat/rescreen-held-backlog` (off `main` @ 73413ca)
Status: built, tests green, PR open (Yoav merges)

## Goal

Give the admin a one-click way to re-run the CURRENT safety judge over the
stories the OLD judge held, and auto-publish the ones it now clears.

## Why

The legacy judge (gpt-5-nano + a 0.7 confidence gate) held ~98% of an ordinary
AITA-style feed. All-time on prod: 6 auto-published vs 119 held. The v2 judge
(gpt-5.4-mini, recalibrated prompt, no confidence gate) was switched on
(`safety_judge.mode = active`) on 2026-07-19 and fixes NEW stories — but a hold
is final for the unattended lanes, so the ~119 already-held stories stay held.
Clearing them one "Publish anyway" click at a time is not viable. This drains
the backlog through the recalibrated judge instead.

## Approach (chosen)

Reuse the shared per-story approve step (`approveReviewedStory`) so the judge
call, publish gate, social scheduling, decision logging, and the emergency-stop
guard all stay in one place (rule 20). A new coordinator selects held stories
and loops them through that step.

- **`src/lib/rescreen-held-backlog.ts`** — `rescreenHeldBacklog({limit,nowMs})`
  and `countRescreenBacklog()`. Candidate = `status='review'` + has an
  `auto_held` decision + not yet touched by the re-screen actor
  (`decided_by = 'rescreen-backlog'`). A no-op breaker keeps this manual pass
  from ever tripping a live lane. Bounded per call (default 25); the UI clicks
  again while `remaining > 0`.
- **`rescreenHeldBacklogAction`** in `scheduler-actions.ts` — `content.manage`
  gated; refuses while the emergency stop is engaged (it publishes without a
  per-story human look); revalidates.
- **`RescreenBacklog.tsx`** — button in the "Held & why" section showing the
  backlog size, a result summary, and the remaining count.
- **`export const maxDuration = 300`** on the scheduler page so the batch (up to
  25 judge calls) has the same ceiling as the cron lanes (Next route segment
  config governs all Server Actions on the page).

### Drain invariant

Each processed story is marked (still-held → fresh `auto_held` by the re-screen
actor; published → leaves review). Both are excluded from later batches, so
repeated clicks converge to zero without re-touching the same rows. A still-held
story's fresh row also carries the NEW judge's reason, so the "held & why" list
updates in place. Exceptions are left unmarked on purpose (retried next batch,
like the live lanes treat a throw); the failed counter surfaces a stuck story.

### Alternatives rejected

- **Background job / queue** — more infra than a resumable, bounded,
  click-to-continue action needs.
- **Re-judge without publishing (report only)** — the ask was to auto-release
  the cleared ones; a report still leaves hundreds of manual clicks.
- **Unbounded single pass over all ~119** — risks the function timeout; the
  bounded+resumable design is strictly safer and needs no cap warning.

## Security (rule 13)

- `content.manage` capability required (same as the manual approve path).
- Honours the unattended-publish emergency stop (fail closed): refuses at the
  action, and `approveReviewedStory` skips per story as a mechanical backstop.
- Publishes only through `publishStoryIfReady` (asset completeness + self-heal);
  an asset-incomplete story cannot go live.
- No-op breaker cannot disable a live lane.

## Observability (rule 14)

- `[rescreen backlog] batch done` (processed/published/stillHeld/deferred/
  failed/skipped/remaining) in the lib.
- `[scheduler rescreen_backlog]` with actorId in the action.
- Per-story `[autopilot safety]` + `[rescreen approve]` lines via the shared step.

## Testing (rule 18)

`src/lib/rescreen-held-backlog.test.ts` (9 tests, green): publishes a cleared
story and drains it; marks a still-held story with the new verdict and skips it
next time; honours the batch limit + remainder; never touches a non-held review
story; defers when assets are not ready; publishes nothing under the emergency
stop; backlog count excludes already-re-screened and non-held stories. Adjacent
suites (approve-reviewed-story, render-auto-publish, autopilot, publish-scheduler)
still green (102). tsc clean on touched files (7 pre-existing errors elsewhere).

## Settings (rule 15)

No new persistent setting. Batch size is a code constant
(`RESCREEN_DEFAULT_LIMIT = 25`), not exposed — a one-shot catch-up tool does not
need a knob. Intentionally not surfaced.

## Deploy (rule 19)

PR into `main`; Yoav merges (merge to main triggers the Vercel prod deploy).
Feature is inert until an admin clicks the button. No schema change (reuses
existing `scheduler_decisions`). Rollback: revert the PR; nothing persists but
ordinary decision rows and normal publishes.

## Open follow-ups

- The button clears the backlog in batches of 25; a very large backlog is
  several clicks. Fine for a one-time catch-up.
- Deferred (assets-not-ready) stories keep the old reason in the held list until
  the normal lane finishes them; cosmetic only.
