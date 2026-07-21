# Render and Publish Schedulers

Date: 2026-07-01
Status: Proposed (awaiting approval to build)
Author: Yoav + Claude Code
Council: pressure-tested via llm-council on 2026-07-01 (verdict folded in below)

## What we are building

Two automation layers on top of the existing pipeline, bridged by a human approval gate:

1. **Render Scheduler (cost governor).** Automatically enqueues Reddit sources for full rendering at a steady, rate-limited drip, always pulling the highest-priority source next, and stops itself when the human falls behind or the budget is spent. Rendered stories land in the existing `review` status.
2. **Publish Scheduler (rate governor).** After a human approves a reviewed story, it schedules that story onto each social platform independently, honoring a per-platform daily cap and fixed posting time slots, and dispatches each post at its slot without double-posting.

The human approval gate sits between them: nothing publishes until a person approves it. This is a deliberate brand and safety control, not a nice-to-have.

## Goals

- Turn the backlog of imported Reddit sources into a paced, predictable stream of rendered videos without a human clicking "Process N" every day.
- Publish approved videos to YouTube, TikTok, Instagram, and Facebook on a controlled schedule (caps + fixed times per platform) instead of firing everything the instant it renders.
- Keep a human in the loop for quality and brand safety, with as little manual effort as possible.
- Be genuinely flexible where flexibility earns its keep (rates, caps, slots, priority, per-platform on/off) while staying obvious and effortless for a lazy admin.
- Never spend money faster than a human can review, and never violate platform rate limits or post duplicates.

## Constraints

- Build on the existing infrastructure, do not reinvent it: DB-backed queue tables, Vercel cron drains authed by `CRON_SECRET`, the "nudge" eager-drain pattern, the `settings` table with kill-switch toggles, and the per-platform `*_posts` tables with their retry/backoff crons.
- Deployment target is Vercel serverless (Node + Python) plus Cloud Run for heavy rendering. Vercel cron granularity is per-minute at best. Function ceiling is 800s (`maxDuration`).
- The app lives in the nested `lorewire-app/` directory inside the git root. Paths below are relative to the git root.
- Real per-render cost is a documented 50 cents (`ESTIMATED_JOB_COST_CENTS = 50` in [lorewire-app/src/lib/story-jobs-budget.ts](lorewire-app/src/lib/story-jobs-budget.ts), with a TS-to-Python parity test). Confirm against the actual monthly provider bills before turning the drip up.
- UI must match the existing admin style: Tailwind v4 with the project design tokens, server components + server actions, the `SettingToggle` / `SettingSlider` / `SettingSelect` kit in [lorewire-app/src/app/admin/(panel)/settings/_components/SettingControls.tsx](lorewire-app/src/app/admin/(panel)/settings/_components/SettingControls.tsx), and capability-based RBAC.
- No new paid dependency. The existing DB-queue + cron-drain pattern (19 crons in production) is the queue engine.

## Requirements

### Functional
- Render Scheduler drips sources into `story_jobs` at a configurable rate, selecting by strict priority tier (STRONG before MEDIUM before none), tie-broken by engagement (`comments` DESC) then recency (`date_written` DESC). This ordering already exists as the `strength DESC` sort in [lorewire-app/src/lib/reddit-source.ts](lorewire-app/src/lib/reddit-source.ts) (line 333: `CASE strength ... DESC, comments DESC`).
- Render Scheduler respects the existing budget cap (`pipeline.story_jobs.daily_cap_cents`) and active-jobs cap (`MAX_ACTIVE_JOBS = 50` in [lorewire-app/src/lib/story-jobs-live-shared.ts](lorewire-app/src/lib/story-jobs-live-shared.ts)).
- Render Scheduler throttles on **review-queue depth** (backpressure), not just budget. It stops enqueuing when unpublished reviewed stories pile up or when no human has approved or rejected anything for N hours.
- Human gate exposes both **Approve** and **Reject** actions. Rejects are counted and logged.
- Rendered-but-unpublished stories have a **freshness TTL**; a GC pass expires stale ones so the queue does not fill with corpses.
- Publish Scheduler assigns a slot **at approval time**: for each enabled platform, it finds the next open slot (a slot time not already filled to that platform's daily cap) and writes a scheduled `*_posts` row.
- A per-minute dispatch cron fires scheduled posts that are due, with strict idempotency (no double-posts).
- Publish state is **per-platform-per-story**. A story can be published on YouTube while still scheduled on TikTok, or succeed on two platforms and fail on two.
- Both schedulers have an independent kill switch (reuse the settings kill-switch pattern).
- Admin can see, at a glance: render drip status, review-queue depth, today's scheduled and posted counts per platform, and a clear "paused" or "nothing posted today" state.

### Non-functional
- Fail closed. Missing `CRON_SECRET`, unreadable settings, or a tripped kill switch means "do nothing," never "publish anyway."
- No duplicate posts, ever, even across cron overlap, retries, and platform accept-but-timeout responses.
- DST-safe scheduling. Slots are wall-clock strings resolved to UTC per day, never precomputed.
- Every automated action logs a structured event for observability, following the existing `namespacedLog` pattern.

## Chosen approach (v1)

### Data model changes

**reddit_source** (existing table): add one column.
- `priority_score` INTEGER. In v1 this is derived purely from the tier (strong = 2, medium = 1, none = 0). The column exists now so v2 can populate it from a weighted formula without a migration. Selection in v1 does not depend on this column being clever; it uses the existing tier + comments + date ordering.

**stories** (existing table): add freshness tracking.
- `render_scheduled` INTEGER (0/1) or reuse an existing flag to mark rows the Render Scheduler enqueued (so we can distinguish auto-drip from manual "Process N").
- `review_ready_at` TIMESTAMPTZ (when the story entered `review`), used by the TTL/GC pass. If an equivalent timestamp already exists, reuse it.

**scheduler_decisions** (new small table): the cheap, write-only instrumentation the council kept from the "flywheel" idea.
- `id`, `story_id`, `reddit_id`, `decision` ('approved' | 'rejected'), `tier`, `comments`, `age_hours`, `subreddit`, `decided_by`, `decided_at`.
- This is the only piece of the self-tuning vision we build now. It lets us answer "should we have used weighted priority" with data later, at near-zero cost today. No analytics wiring, no self-tuning in v1.

**Per-platform `*_posts` tables** (existing: `youtube_posts`, `facebook_posts`, `instagram_posts`, `tiktok_posts`, plus story variants): add two columns each.
- `scheduled_for` TIMESTAMPTZ. Null for legacy immediate posts; set when the Publish Scheduler assigns a slot.
- `slot_state` TEXT: `scheduled` -> `publishing` -> `published` | `failed`. Coexists with the existing `status` field (which the retry crons already use).
- Add a unique constraint on `external_post_id` (per platform) as a hard idempotency backstop.

### New cron endpoints

**`/api/render_enqueue`** (Render Scheduler), every 5 minutes, self-throttling to the configured hourly rate.
1. Auth via `CRON_SECRET`. Bail if the render kill switch is off.
2. **Backpressure gates (run before anything else):**
   - Count reviewed-but-unpublished stories. If >= `render.review_queue_cap`, stop (log "paused: review backlog").
   - Check the most recent approve/reject in `scheduler_decisions`. If older than `render.stale_hours` (default 48), stop (log "paused: no human activity").
   - Check budget via the existing `story-jobs-budget` helper and the active-jobs cap. If over, stop.
3. Compute how many to enqueue this tick given `render.rate_per_hour` and time since last enqueue.
4. Select that many eligible sources (status `imported`, matching the eligibility filter) ordered by tier, comments, date. Enqueue them via the existing `bulkEnqueueStoryJobs` in [lorewire-app/src/lib/story-jobs.ts](lorewire-app/src/lib/story-jobs.ts). Nudge the existing drain.

**`/api/publish_dispatch`** (Publish Scheduler), every 1 minute.
1. Auth via `CRON_SECRET`. Bail if the publish kill switch is off.
2. Across all platform `*_posts` tables, select rows where `slot_state = 'scheduled'` AND `scheduled_for <= now()`, using `FOR UPDATE SKIP LOCKED` (Postgres) so two overlapping cron runs cannot claim the same row.
3. Flip each to `slot_state = 'publishing'` (this flip is the idempotency key), then call the existing per-platform publish function (`publish-to-youtube.ts`, etc.).
4. On success set `published` + `external_post_id`; on failure set `failed` and let the existing retry cron handle backoff. The unique constraint on `external_post_id` is the backstop against a double-insert.

**`/api/expire_stale_reviews`** (GC), every hour.
1. Auth via `CRON_SECRET`.
2. Find `review` stories older than `render.freshness_ttl_days` (default 7) that were never approved. Move them to `archived` (or a `stale` status) and log. This frees the review queue of dead content.

All three follow the exact `isAuthorized` + `serve` + GET/POST pattern used by every existing cron (see [lorewire-app/src/app/api/auto_publish_full_pipeline/route.ts](lorewire-app/src/app/api/auto_publish_full_pipeline/route.ts)). All three get added to [lorewire-app/vercel.json](lorewire-app/vercel.json) with staggered offsets so they never all fire on the same tick.

### Slot assignment (the heart of the Publish Scheduler)

When a human approves a story:
1. For each enabled platform (`{platform}_enabled = 1`):
   - Read `{platform}_slots` (JSON array of `"HH:MM"` wall-clock strings) and `{platform}_timezone`.
   - Read `{platform}_daily_cap`.
   - Resolve today's and upcoming days' slots to UTC instants (per day, using a timezone library, so DST is correct).
   - Walk forward from now: the next open slot is the earliest slot instant that is in the future and whose day has not already hit the daily cap for that platform.
   - Insert a `*_posts` row with `slot_state = 'scheduled'` and `scheduled_for` = that instant.
2. Write one `scheduler_decisions` row (`decision = 'approved'`).

Rejecting a story writes a `scheduler_decisions` row (`decision = 'rejected'`) and moves the story out of the review queue (back to `draft` or `archived`, admin's choice).

### The "two meanings of next" resolution

Render selects by priority; publish selects by next-open-slot. To keep priority meaningful all the way to publishing without building a slot-reshuffler in v1:
- The **review queue is sorted STRONG-first** (same tier ordering as rendering).
- A human approving top-down therefore assigns the best content to the earliest slots naturally.
- Known v1 limitation, stated plainly: if the admin approves out of priority order, posts go out in approval order, not tier order. Re-sorting already-scheduled slots by tier is a v2 refinement. This is acceptable because a human is choosing the order anyway.

### Settings (namespaced, in the existing `settings` table)

Render Scheduler:
- `render.enabled` (kill switch)
- `render.rate_per_hour` (drip rate; default tuned to the budget, see open questions)
- `render.review_queue_cap` (backpressure ceiling; default 20)
- `render.stale_hours` (pause if no human activity; default 48)
- `render.freshness_ttl_days` (GC age; default 7)
- `render.eligibility` (which sources qualify: min strength, subreddit allow/deny; default strength >= medium)

Publish Scheduler, per platform (`youtube` | `tiktok` | `instagram` | `facebook`):
- `publish.{platform}.enabled`
- `publish.{platform}.daily_cap`
- `publish.{platform}.slots` (JSON `["09:00","13:00","18:00"]`)
- `publish.{platform}.timezone` (IANA name, e.g. `America/New_York`)
- `publish.enabled` (global publish kill switch)

### Admin UI

A new `/admin/scheduler` page, gated by `settings.manage`, built with the existing `SettingsShell` + control kit. Two tabs:

1. **Rendering.** Drip rate, eligibility filter, backpressure caps, TTL, kill switch. Above the controls: a live status strip showing "Rendering: active / paused (reason)", today's enqueued count, and current review-queue depth. Progressive disclosure: rate + on/off are front and center; caps and TTL live under an "Advanced" fold.
2. **Publishing.** A sub-tab or card per platform: on/off, daily cap, slot chips (add/remove `HH:MM`), timezone. Above them: a per-platform "today" line ("YouTube: 2 of 3 posted, next at 18:00", "TikTok: paused"). A prominent global "nothing posted today / publishing paused" banner when true, because that is the first thing a lazy admin panics about.

The **review queue** itself (Approve / Reject) extends the existing review surface (the admin story list / `/admin/content`), sorted STRONG-first, with Approve and Reject buttons and a visible queue-depth count. We reuse what exists rather than building a new review screen.

## Lazy-user walkthrough (rule 10)

- **First visit to `/admin/scheduler`:** the admin sees two toggles, both off by default, with plain-language one-liners ("Automatically render top Reddit sources" / "Automatically post approved videos on a schedule"). Turning on Rendering with defaults just works; no required configuration.
- **Daily loop:** admin opens the review queue, sees STRONG stories first, watches each short, clicks Approve or Reject. Approve schedules it across platforms automatically. That is the entire manual job.
- **Vacation:** admin approves nothing for two days. Rendering auto-pauses (stale_hours) instead of burning budget. Publishing drains whatever was already scheduled, then goes quiet. Nothing piles up invisibly. On return, the status strip explains exactly why rendering is paused.
- **Refresh / back button / mobile:** all state is server-side in the DB and settings table, so refresh and navigation are safe. The page is a server component; there is no fragile client state to lose.
- **"Why is nothing posting?":** the banner answers it directly (paused, cap reached, no approved content, or slots not yet due) instead of leaving the admin guessing.

## Security and safety (rule 13)

- **Sensitive data:** Reddit-derived text can carry PII (usernames, personal stories). The human gate is the primary content-safety control; v1 never auto-publishes without approval. Reject exists specifically so a human can kill unsafe content before it spends a slot.
- **Attack surface:** the three new cron endpoints. All require the `CRON_SECRET` bearer token and fail closed without it, matching every existing cron.
- **AuthZ:** scheduler settings gated by `settings.manage`; Approve/Reject gated by `content.manage`. Server actions re-check the capability, never trusting the client.
- **Secrets:** OAuth tokens stay where they are today (resolved at publish time, not stored in scheduler rows). Logs never record tokens or full PII, only ids and decision metadata.
- **Fail-safe defaults:** both kill switches default off; every gate (budget, backpressure, cap, slot) blocks rather than allows on ambiguity.
- **Idempotency as a safety property:** double-posting is not just a bug, it spends money, spams followers, and risks platform strikes. `SKIP LOCKED` + flip-to-`publishing` + unique `external_post_id` constraint together prevent it.
- **Rate limits as ToS protection:** per-platform caps keep us under platform automation and quota limits, reducing suspension risk.
- **Platform AI-disclosure ToS:** the code already sets YouTube `synthetic` (containsSyntheticMedia) and TikTok `is_aigc` flags. Verify current YouTube and TikTok synthetic-media disclosure rules online before launch (rule 1, rule 13); do not trust training-data memory of ToS.
- **Cost as a safety rail:** review-queue backpressure guarantees spend cannot outrun human review. Budget cap remains the hard ceiling.

## Alternatives considered and rejected

- **Single unified pipeline (no split).** Rejected: rendering and publishing govern two different scarce resources (dollars vs platform quota and attention). One knob for both makes each impossible to reason about. The council was unanimous on keeping the split.
- **Full auto, no human gate.** Rejected by the user for brand and legal risk: AI-written, Reddit-derived content hitting public accounts unseen. Per-platform full-auto can be reconsidered in a later phase once decision logs show the output is reliably safe.
- **Weighted priority score in v1.** Rejected for v1 after council pressure-test: since a human approves every story, a tunable four-factor score mostly reorders a queue the human re-sorts anyway, and nobody tunes four sliders correctly. We keep the `priority_score` column and the decision log so weighted scoring is a v2 config change, not a rebuild. (User confirmed strict tiers for v1 with eyes open.)
- **External job queue (Inngest, BullMQ, QStash).** Rejected: adds a paid dependency and new infrastructure to a system whose DB-queue + cron-drain pattern already runs 19 crons in production. No cost justification (rule 8).
- **"Keep the pipeline full" target-fill trigger.** Rejected in favor of rate-based drip (user's choice): simpler and makes daily spend predictable.

## v1 scope vs v2

**v1 (build now):** rate-drip render with strict tiers; review-queue backpressure; approve + reject gate; freshness TTL + GC; per-platform independent daily caps, fixed slots, timezones, on/off; slot assignment at approval time; per-minute idempotent dispatch; per-platform-per-story publish state; two kill switches; the `/admin/scheduler` page; cheap decision-vector logging; prominent review-depth and "nothing posted today" visibility.

**v2 (deferred):** weighted priority formula and self-tuning weights; post-publish analytics flywheel (views / watch-time / follows fed back onto source features); dynamic slot rebalancing by tier; per-source pacing; retry-into-next-slot; per-platform format variants (e.g. reframing 9:16 for YouTube); multi-account and cross-post A/B variants.

## Build order (first shippable path)

1. **Backpressure first.** Add the review-queue-depth + stale-hours gates as a standalone helper with unit tests, before any drip exists. This is the one flaw that turns the system into a money fire; build the brake before the accelerator.
2. **Render Scheduler.** `priority_score` column, eligibility setting, `/api/render_enqueue` cron wired to `bulkEnqueueStoryJobs`, the render settings, and the Rendering tab. Ship and watch it drip with backpressure engaged.
3. **GC.** `/api/expire_stale_reviews` + `review_ready_at` + TTL setting.
4. **Publish schema.** `scheduled_for` + `slot_state` columns + unique `external_post_id` constraint on each `*_posts` table.
5. **Slot assignment** at approval time (the DST-safe next-open-slot logic) + Approve/Reject actions + `scheduler_decisions` logging.
6. **Publish dispatch.** `/api/publish_dispatch` per-minute cron with `SKIP LOCKED`.
7. **Publishing tab + status/visibility UI.**
8. **QA pass** (rule 6): golden path, vacation/backpressure, DST boundary, double-fire idempotency, partial-publish, reject accounting, cron overlap.

## Confirmed defaults (2026-07-01)

The user approved building on the defaults below. Every one of them is stored in the `settings` table and editable in `/admin/scheduler`; these are only the starting values, not hardcoded behavior.

- **Drip rate:** 12 renders/day (about 6 dollars/day at 50 cents/render). Editable via `render.rate_per_hour`. Confirm real cost against provider bills before raising.
- **Posting slots:** 09:00 / 13:00 / 18:00 per platform. Editable via `publish.{platform}.slots`.
- **Timezone:** `America/New_York` default (user did not name an audience timezone; this is the safest English-audience default and is fully changeable). Editable per platform via `publish.{platform}.timezone`.
- **Reject destination:** rejected stories go to `draft` (re-editable), not `archived`.
- **Eligibility:** auto-render strength >= medium only (skip `none`), all subreddits. Editable via `render.eligibility`.
- **Format:** one rendered 9:16 short posts as-is to all four platforms in v1. Per-platform reframing is v2.

## Still to verify before launch (not blockers to build)

- Real per-render dollar cost against actual provider bills (rule 8).
- Current YouTube and TikTok synthetic-media / automated-content disclosure rules (rule 1, rule 13).
