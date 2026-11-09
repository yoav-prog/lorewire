# Render Scheduler auto-publish lane

Date: 2026-07-12
Branch: `feat/render-scheduler-auto-publish` (off fresh `origin/main`, which
already contains PR #247, the autopilot gate-refusal-hold fix).

## Problem

The Render Scheduler drip (`/api/render_enqueue` -> `runRenderDrip`) creates
stories and the Python worker renders them, but every story lands in `status =
'review'` and waits for a human to approve it. There is no path that publishes a
render-scheduler story automatically once its assets are complete. The owner has
to click Approve on each one.

Autopilot's approve tick already does exactly the wanted behaviour (screen ->
gate -> schedule -> defer/hold -> breaker) but only for stories it pulled itself
(`story_jobs.requested_by = 'autopilot'`) and only in `live` / `autonomous`
mode. It never touches render-scheduler stories.

## Goal

When the owner opts in, a render-scheduler story that is asset-complete and
passes the AI safety judge publishes automatically (site + scheduled social
posts), without a human approval step and without forcing Autopilot's
source-pulling on. Off by default. Human-created review stories are never
touched.

## Why this is safe to scope

The render drip stamps every job it enqueues with `requested_by =
'render-scheduler'` (`RENDER_SCHEDULER_REQUESTED_BY`,
`src/lib/render-scheduler.ts`). So the auto-publish lane can select strictly
`story_id IN (SELECT story_id FROM story_jobs WHERE requested_by =
'render-scheduler')` and can never adopt a story a human made or is holding in
review.

## Architecture (rule 20: single source of truth)

The per-story orchestration (safety screen -> `publishStoryIfReady` gate ->
`scheduleStoryPublish` -> gate-refusal defer/hold ladder -> circuit breaker) is
the subtle, incident-prone logic (the 2026-07-09 breaker incident lived here).
It is extracted once and both lanes call it.

New / changed modules:

1. `src/lib/story-safety-judge.ts` (new) — move `screenStoryForAutopilot`,
   `detectDegenerateStory`, judge consts + types out of `autopilot.ts`.
   Imports only `@/lib/llm`. `autopilot.ts` re-exports the two functions so
   existing imports and `autopilot.test.ts` keep working unchanged.

2. `src/lib/approve-reviewed-story.ts` (new) — `approveReviewedStory(story, {
   decidedBy, breaker })`. The shared per-story loop body. `breaker` is injected
   (`{ recordFailure, resetFailures }`) so a systemic failure in a lane disables
   that lane, not the other. Also holds `countGateRefusals` (moved from
   autopilot) since the ladder lives here now. Returns a discriminated outcome
   (`approved | held | deferred | skipped | failed`) plus `tripped`.

3. `src/lib/autopilot.ts` — `runAutopilotApprove` becomes a thin batch loop over
   `approveReviewedStory` with autopilot's breaker. `screenStoryForAutopilot`,
   `detectDegenerateStory`, `recordAutopilotFailure`, `resetAutopilotFailures`
   stay/reexport; behaviour identical (proven by `autopilot.test.ts` unchanged).

4. `src/lib/render-auto-publish.ts` (new) — `runRenderSchedulerAutoPublish()`:
   gated on `render.auto_publish`; selects render-scheduler review candidates
   (oldest first, excluding already `auto_held`); runs `approveReviewedStory`
   with the render lane's own breaker. Batch limit mirrors autopilot (3/tick).

5. `src/app/api/render_auto_publish/route.ts` (new) — cron, mirrors
   `autopilot_tick` exactly (CRON_SECRET Bearer + invoke + namespaced log).
   `vercel.json` gets one cron entry `*/2 * * * *` + function maxDuration 300.

Import graph (no cycles): safety-judge -> llm; approve-reviewed-story ->
safety-judge + auto-publish + publish-scheduler + reddit-source + db; autopilot
-> approve-reviewed-story; render-auto-publish -> approve-reviewed-story +
render-scheduler settings.

## Settings (rule 15)

- `render.auto_publish` — default `"0"` (OFF). Reader `getRenderAutoPublish()` in
  `render-scheduler.ts` next to `getRenderEnabled`.
- Render lane breaker keys: `render.auto_publish_consecutive_failures`,
  `render.auto_publish_tripped_at`. Reuses `autopilot.alert_email` for the
  alert destination (one owner mailbox).
- Admin: a new toggle on the Render Scheduler card, "Auto-publish stories when
  ready", default off, caption stating the safety-judge-only trade plainly.

## Security / safety (rule 13)

- Cron behind `CRON_SECRET` Bearer, identical to every other cron.
- Fail closed: judge outage/malformed -> hold; gate refusal -> defer then hold
  after `gateRefusalHoldAfter`; systemic exception -> lane breaker trips
  `render.auto_publish` to off + emails the owner.
- Sensitive truth, stated for the record: with this ON, the AI safety judge is
  the only gate between a rendered story and the public site + 4 social
  platforms. The judge is the same one already in production for autopilot;
  no new model, no new risk surface, but real. Off-by-default.

## Observability (rule 14)

- `[render-autopublish tick]` per run: approved / held / deferred / failed /
  skipped / tripped + reason.
- Shared per-story logs (`[autopilot safety]`, gate-refusal warn) come along in
  the shared helper. Mirror autopilot's "published but ZERO social posts queued"
  warning when the publish master switch is off.

## Testing (rule 18)

- `approve-reviewed-story.test.ts` (new): golden publish, judge-hold,
  gate-refusal defer->hold ladder, already-published skip, exception->breaker
  (injected breaker fires).
- `render-auto-publish.test.ts` (new): disabled -> noop; picks only
  `render-scheduler` rows (a render-scheduler story publishes; an identical
  human row and an autopilot row are left in review); own breaker flips
  `render.auto_publish`, not `autopilot.mode`.
- `autopilot.test.ts`: must pass UNCHANGED (proves the extraction preserved
  behaviour).

## Deploy (rule 19)

Feature branch -> PR into `main` -> merge triggers the normal Vercel deploy of
post-merge main. Ships dark (toggle off). One `vercel.json` cron added. Do not
touch `main` or promote in the Vercel UI; the owner merges. Rollback: flip
`render.auto_publish` off (instant, no deploy) or revert the PR.

### Two behaviour side effects to expect once ON

1. Render volume rises: draining the review queue removes the `review_backlog`
   backpressure that pauses new renders, so the drip runs toward
   `render.rate_per_hour` (default 0.5/hr = 12/day). The rate limiter still
   bounds it.
2. If the publish master switch is off, stories still go live on the SITE (status
   flips) with zero social posts queued (same as autopilot today); the
   ZERO-posts warning fires.

## Alternatives rejected

- Blanket "publish any ready review story" cron — bypasses the judge and eats
  human-parked stories. No.
- Reuse Autopilot autonomous mode — forces autopilot source-pulling on the
  owner. Rejected by the owner.

## Open questions

- Should the render lane share autopilot's breaker threshold (3) — yes for now,
  via `AUTOPILOT_DEFAULTS.breakerThreshold`, to avoid a second constant.
- Separate cron vs piggyback `autopilot_tick` — separate cron chosen to keep the
  two features independent (owner's stated preference).
