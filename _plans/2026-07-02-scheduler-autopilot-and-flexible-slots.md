# Scheduler v2: Autopilot + flexible posting schedule

Date: 2026-07-02
Branch: `feat/scheduler-v2-autopilot-slots`
Builds on: `_plans/2026-07-01-render-and-publish-schedulers.md` (v1, shipped in PR #182)

## Goals

1. An **Autopilot** option: when the human review queue is empty, pull STRONG-only
   Reddit sources up to a daily limit, run them through the full pipeline, and
   publish end-to-end with no human click. Site publish stays instant; social
   posts keep flowing through the per-platform slot scheduler.
2. A **more flexible posting schedule**: per-platform times that can differ by
   day of week, the ability to schedule a specific story to a specific
   date/time, and a calendar-style preview of the upcoming week.
3. Verification that the v1 scheduler works stays true throughout: one publish
   path, all existing tests green, everything default-off.

## Scope decisions made by the owner (2026-07-02)

- Autopilot is **STRONG-only**. Medium/weak sources keep flowing to the human
  review queue exactly as today.
- Autopilot triggers **only when the review queue is empty** (a fallback, not a
  firehose). Manual curation always takes priority.
- Schedule UI gets weekday recurrence, a calendar preview, **and**
  specific-date scheduling for individual stories.
- Site publishing stays **instant on approve**; only social posts wait for slots.

## Council verdict (design pressure-test, 2026-07-02)

Five-advisor council + anonymous peer review. Consensus findings folded in:

- **"STRONG" is a triage tier, not a safety gate.** It ranks source potential
  for a human who was going to read the story anyway. Autopilot must not
  repurpose it as the only brand-safety mechanism. → Added: a content safety
  check between render and auto-approve, and a shadow mode before live mode.
- **Review-queue contamination.** Autopilot stories parked in `status='review'`
  race the stale-archive sweep, count against the review cap, and flap the
  empty-queue gate. → Added: autopilot stories are tagged via
  `story_jobs.requested_by='autopilot'`; the empty-queue gate counts only
  non-autopilot review stories; the stale sweep skips in-flight autopilot
  stories in live mode; auto-approve claims stories atomically.
- **No retraction path (unanimous peer-review catch).** Every safeguard
  discussed prevents the *next* bad publish; nothing recalls one already live.
  → Added: a Retract action (cancel queued social rows + unpublish from site +
  delete platform posts where the API allows; TikTok has no delete API, so it
  is listed for manual cleanup).
- **Cron idempotency.** Vercel crons are at-least-once. → Auto-approve does an
  atomic claim (`UPDATE ... WHERE status='review'`) before publishing, same
  pattern as the publish dispatcher.
- **Circuit breaker, not just a kill switch.** Nobody is awake to flip a toggle
  at 3am. → Autopilot auto-disables itself after N consecutive failures and
  sends an alert email via the existing Brevo helper.
- **Ship dark, start tiny (Executor).** Autopilot ships with three modes:
  Off / Shadow / Live. Shadow renders and tags but stops before auto-approve so
  a week of "what it would have published" can be eyeballed. Live starts with
  daily limit default 1.
- **Provenance.** Published stories show how they got published (human /
  autopilot) in the admin, via `scheduler_decisions`.
- **Empirical trust.** The autopilot UI shows the historical STRONG-tier
  approve/reject ratio from `scheduler_decisions` so the trust decision is
  data-backed, not vibes.
- **Legacy `full_pipeline=1` instant-blast lane** was flagged by multiple
  advisors as a loaded gun next to the new gating. Out of scope to remove here;
  flagged as a recommended follow-up (retire it or fold it into the slot path).

## Rejected alternatives

- **Extending the legacy `full_pipeline` lane for autopilot.** Rejected: it
  bypasses the slot scheduler and dedup; would create a second publish path.
  Autopilot rides the exact same `publishStoryIfReady()` +
  `scheduleStoryPublish()` calls a human approve uses.
- **Autopilot running continuously alongside the queue.** Rejected by owner:
  fallback-only keeps human curation primary.
- **Publish-with-veto (24h cancellable buffer) instead of shadow mode.**
  Considered (First Principles advisor); shadow mode + daily-limit-1 live ramp
  achieves the same trust-building with less machinery. The veto window can be
  revisited if shadow reveals problems.
- **A settings migration for the slots shape.** Rejected: parse both shapes
  forever, write the new shape on save. No migration on live settings.

## Design

### Stage C — weekday-aware slots (ships first; D and E depend on it)

- `publish.{platform}.slots` accepts both shapes:
  - legacy flat array: `["09:00","13:00","18:00"]`
  - new: `{"default":["09:00","13:00"],"overrides":{"sat":["11:00"],"sun":[]}}`
- Explicit semantics: an override key that is present with `[]` means **no
  posts that day**. A missing key falls back to `default`.
- Slot resolution stays DST-safe via the existing `Intl.DateTimeFormat` math;
  the weekday is resolved **in the platform's timezone**, not UTC.
- `SlotsEditor` grows a per-day view that always shows the **resolved**
  schedule for each weekday, not the raw override object.

### Stage D — specific-date scheduling

- New server action: schedule a story to an explicit datetime per platform.
  Inserts `scheduled_publishes` rows with the explicit `scheduled_for`
  (slot_local records the wall-clock time, timezone recorded as configured).
- Explicit rows count against daily caps (slot math already counts rows per
  local day; explicit rows land in the same accounting).
- The scheduler page gets an "Upcoming posts" list: every `state='scheduled'`
  row with platform, story, local time, and a Cancel button
  (`state='cancelled'`).

### Stage E — calendar preview

- Server-computed next-7-days view per platform: merges real queued rows
  (visually solid) with projected open slots (visually dashed/ghost).
- Pure function over (slots config, queued rows, now) so it is unit-testable.

### Stage F — Autopilot

- Settings (all under the scheduler page, defaults in parentheses):
  - `autopilot.mode`: `off | shadow | live` (`off`)
  - `autopilot.daily_limit`: int (`1`)
  - internal: `autopilot.consecutive_failures`, `autopilot.tripped_at`
- **Pull tick** (inside the existing `/api/render_enqueue` cron handler, after
  the normal drip): if mode != off AND non-autopilot review count == 0 AND
  today's autopilot pulls < daily_limit AND budget gate open AND sources with
  `strength='strong'` exist → `bulkEnqueueStoryJobs(..., {requested_by:
  'autopilot'})` for the shortfall. Pull count = story_jobs rows with
  `requested_by='autopilot'` requested today (platform timezone-agnostic: UTC
  day, documented).
- **Auto-approve tick** (new `/api/autopilot_approve` cron, every 2 min):
  - mode must be `live`; skip entirely in shadow.
  - candidates: stories in `status='review'` whose story_job has
    `requested_by='autopilot'`.
  - safety check: a content-policy screen over title+article using the
    existing Gemini client (same provider as SEO metadata; adds well under a
    cent per story, inside the existing budget gates). Fail → story stays in
    review for a human, decision logged as `auto_held`.
  - atomic claim, then the exact human-approve path: `publishStoryIfReady()` +
    `scheduleStoryPublish()`; decision logged as `auto_approved` with
    `decided_by='autopilot'`.
  - failure handling: consecutive-failure counter; at 3, set mode to `off`,
    record `tripped_at`, send alert email via `sendBrevoEmail` to the admin.
- **Queue hygiene**: the render drip's empty-queue/backpressure math and the
  stale-review sweep both learn to distinguish autopilot rows (live-mode
  autopilot stories are transient; shadow-mode rows behave like normal review
  rows and DO count toward staleness/caps, because a human is expected to look).
- **UI**: a new Autopilot card on the scheduler page between Rendering and the
  review queue: mode select with plain-language descriptions, daily limit
  slider, the STRONG approve/reject history stat, circuit-breaker status (and
  a "tripped" banner with the reason when auto-disabled). Review queue rows
  from autopilot get an unmistakable badge (Shadow: "autopilot would publish
  this"; Live: "publishing automatically").

### Retraction

- Admin action on a published story: Retract.
  1. Cancel all `scheduled_publishes` rows still `scheduled` for the story.
  2. Unpublish from the site (`status='archived'`, autocurate cleanup).
  3. Delete platform posts where supported: `deleteYouTubeVideo`,
     `deleteFacebookPost`, `deleteInstagramPost` (all already exist). TikTok
     has no delete API — surface the posted link with "delete manually".
  4. Log every step; partial failures reported per-platform, retryable.

## Security

- Sensitive surface: unattended publishing to 4 external accounts. Mitigations:
  default-off, shadow-first, STRONG-only, daily limit, safety screen, circuit
  breaker, retraction, provenance audit trail. All admin actions behind
  existing capability checks (`settings.manage` / `content.manage`). Cron
  routes keep `CRON_SECRET` bearer auth. No new secrets; reuses existing
  Gemini/Brevo/platform credentials. Fail closed: any gate read error counts
  as "gate closed".

## Observability

- `[autopilot pull]`, `[autopilot approve]`, `[autopilot safety]`,
  `[autopilot breaker]` namespaced logs with actual values (counts, story ids,
  gate reasons), mirroring the v1 `[render_enqueue tick]` pattern.
- Every decision lands in `scheduler_decisions` (`auto_approved`, `auto_held`,
  plus existing `approved`/`rejected`).
- Circuit-breaker trips: log + email.

## Settings audit

New user-facing controls, all on `/admin/scheduler`: autopilot mode,
autopilot daily limit, per-weekday slots. Intentionally NOT exposed:
the STRONG-only rule (hard-coded; loosening it is a future decision that
should be made with data), safety-check threshold (internal), breaker
threshold (internal, 3).

## Testing

- Stage C: parse both slot shapes; `[]` override = no posts; missing day =
  default; weekday resolved in platform tz across DST boundaries; write-back
  shape.
- Stage D: explicit rows respect caps + unique index; cancel transitions.
- Stage E: projection pure function (queued vs projected, 7 days, tz).
- Stage F: pull gate truth table (mode/queue/limit/budget); daily-limit
  counting; auto-approve claim idempotency (two overlapping ticks, one wins);
  safety-fail routes to review + logs `auto_held`; breaker trips at 3 and
  flips mode off; shadow mode never approves.
- Retraction: cancels rows, archives story, calls platform deletes, reports
  partial failure.
- Full existing suite stays green (2548 passing today; 5 pre-existing failures
  on main unrelated to this work, listed in the PR description).

## Deploy

- One branch off fresh `main`: `feat/scheduler-v2-autopilot-slots`, staged
  commits (C → D → E → F → retraction).
- PR into `main`; production tracks `main` (verified 2026-07-02: production
  deployment is `main`@latest). No push/merge without explicit owner approval.
- New cron `/api/autopilot_approve` added to `vercel.json` in the same PR.
- Rollback: everything is default-off; reverting the PR reverts cleanly
  (settings keys simply go unread; no schema migration - only additive
  settings rows and scheduled_publishes rows in existing shapes).

## Open questions / follow-ups

- Retire or slot-integrate the legacy `full_pipeline` instant-blast lane
  (council recommendation; owner decision pending).
- 5 pre-existing test failures on `main` (bulk-content-actions, privacy/terms
  entity naming, aspect parity, personal-data registry) need a separate fix.
- Future: graduated trust (autopilot for MEDIUM after clean STRONG history),
  14-day calendar with drag-to-reschedule, engagement comparison of autopilot
  vs human-approved stories.
