# Fix Autopilot Auto-Publish + Daily Israel-Time Drop

Date: 2026-07-15
Owner: Yoav
Status: Approved (direction), ready to build. Council-reviewed.

---

## The problem (verified in production, read-only, 2026-07-15)

Autopilot is ON (autopilot.mode = autonomous), healthy, and correctly creating
~10 stories/day. But it has *never auto-published a single story*. The
gpt-5-nano safety judge that screens every story before unattended publish is
holding ~100% of them:

- scheduler_decisions all-time: auto_held: 70, auto_gate_refused: 17,
  *auto_approved: 0*.
- *62 of 70 holds are the judge* (only 8 are asset-gate timing).
- Every one of the *10 stories held on 07-15* is a legit 2,000-3,300-char
  story, and *all 66 stories the judge ever held are now published* - a
  *100% false-positive, 0% observed true-positive rate*. The owner has been
  publishing them by hand every morning (~07:23 UTC batch via the flag-based
  auto_complete_publish path, which does NOT run the judge).
- Because nothing auto-approves, no social posts get scheduled: social posting
  stopped after 07-13; scheduled_publishes pending = 0.

### Root cause (calibration, NOT an API error)

The same model + call params (gpt-5-nano, strict jsonSchema,
reasoningEffort: "minimal", omitTemperature) work fine in
comment-moderation.ts and submission-moderation.ts in prod. The judge
reaches OpenAI and genuinely decides "hold" because:

1. The prompt biases to caution ("When unsure, hold").
2. The content is dramatic-sounding interpersonal conflict ("KNIFE WAR AT HOME")
   that trips a safety model.
3. The pass rule is decision === "publish" && confidence >= 0.7
   (PUBLISH_MIN_CONFIDENCE), so any hedged verdict (publish @ 0.6) is held.
4. The verdict's category/reason/confidence is *discarded* - the DB
   stores only auto_held. That observability hole is why this stayed invisible
   for weeks.

### Secondary issues

- *No timezone configured anywhere* -> all social publishing silently uses the
  America/New_York default (09:00/13:00/18:00 NY). Site go-live is instant on
  approval - there is *no scheduled publish time at all* for site content.
- 8 auto_gate_refused holds: the autopilot approve tick gives up after 5
  refusals (~10 min), before the Python thumbnail finisher lands the per-platform
  thumbnail variants. (The manual auto_complete_publish path retries 12x / 24
  min, which is why manual publishing succeeds where autopilot gives up.)
- YouTube had a few video fetch HTTP 403 failures (media URL access) - separate
  publisher issue, not in scope here.

---

## Goals

1. Make autopilot actually publish automatically - reliably, unattended - for
   the safe majority of stories, *keeping a real safety net*.
2. One clear, editable *daily Israel-time (Asia/Jerusalem) drop* governing when
   the day's stories go live on the site and start posting to social.
3. Never again fail silently: the reason a story didn't publish must be visible.

## Owner decisions (locked)

- *D1:* Fix the judge, keep a safety net (pass ordinary drama; hold only
  genuine risks). Add a manual "publish anyway" + a visible "held & why" list.
- *D2:* One daily drop at a set Israel time (default 09:00 Asia/Jerusalem),
  editable.
- *D3:* Full autonomy is the destination, reached via a *validation ramp*
  (observability -> recalibrate -> backtest on the 66-story goldset + seeded bad ->
  shadow days -> enable). Not a switch-flip.

## Constraints

- Production deploys via Vercel from main (main = production as of 2026-07-01,
  per AGENTS.md). Any change ships only through the branch discipline in
  AGENTS.md (fetch, divergence-check both directions, no push to a stale branch).
- Timestamps are stored as TEXT (ISO) in the dual SQLite/Postgres schema - string
  comparison only, no date_trunc/now() on those columns.
- Reuse the existing DST-safe wall-clock helpers - in publish-scheduler.ts
  (wallClockToUtcMs, partsInTz); never hand-roll timezone math (the NY default
  already caused this).

---

## Chosen approach - phased (safety-first ramp)

### Phase 0 - Observability + kill switch (the "one thing to do first")
- Persist the judge verdict on every screen: decision, category, reason,
  confidence. Store on scheduler_decisions (add columns) so every hold is
  explainable. Touch: story-safety-judge.ts (return already carries these),
  approve-reviewed-story.ts (pass them into logSchedulerDecision),
  publish-scheduler.ts::logSchedulerDecision + SchedulerDecisionInput,
  schema.ts (additive columns).
- Admin "Held & why" list on /admin/scheduler: story, category, reason,
  confidence, age, + a one-click *"Publish anyway"* (reuses the existing manual
  publish path the owner already uses every morning).
- Global *kill switch* for unattended publishing (a single setting the owner can
  flip; independent of autopilot.mode), surfaced prominently.
- *Hold-rate alert:* if held/total over the last day exceeds ~30%, log + email
  the alert address (reuse autopilot.alert_email + sendBrevoEmail).

### Phase 1 - Recalibrate the judge
- *Upgrade the model* gpt-5-nano -> gpt-5.4-mini (the app's own default in
  data/models.json). Cost at 10/day is negligible; confirm exact per-call price
  (rule 8) before shipping.
- Rewrite JUDGE_SYSTEM: dramatic interpersonal conflict / AITA drama is
  *explicitly safe*; delete "When unsure, hold." Define the hold taxonomy
  explicitly: (a) a real, findable person named with a damaging/defamatory
  claim; (b) minors in harm / self-harm / suicide; (c) sexual content; (d)
  gratuitous gore/cruelty; (e) clear YouTube/TikTok/Meta policy violations.
- *Flip the logic:* default to publish; hold only when the judge
  affirmatively flags one of the danger categories with reasonable confidence.
  Remove the >= 0.7-to-publish gate (which held hedged "publish" verdicts).
- Keep the deterministic detectDegenerateStory check (body < 250 chars /
  "NO STORY") - it is genuinely useful and cheap.

### Phase 2 - Validate before trusting (the ramp)
- *Backtest harness:* replay all 66 held-then-published stories + a set of
  hand-seeded KNOWN-BAD examples (a fake real-name-plus-damaging-claim, a
  minor-harm story, an explicit one, an obvious policy violation) through the new
  judge. Success bar: clears the 66 (0 false holds) AND catches the seeded bad
  (true positives > 0). Run locally with a test key; no prod writes.
- *Shadow run:* deploy the new judge in shadow (log the new verdict + reason,
  keep current behavior) for a few days while the owner still publishes manually.
  Diff new-verdict vs owner's manual decisions. Confirm hold-rate is sane.

### Phase 3 - Daily Israel-time drop
- Add a single admin control at the top of /admin/scheduler:
  *"Daily site drop time"* + timezone (default 09:00 / Asia/Jerusalem),
  editable, shown as "Next drop: today 09:00 (Israel)".
- *Site go-live:* time-gate the autopilot/render approve step so it publishes
  the day's ready stories to the site during the drop window, using the existing
  wallClockToUtcMs/partsInTz (named-zone, DST-safe). Stories render overnight
  (pull is early-UTC-day), so they are ready before the morning drop.
  Idempotent + cancelable before it fires.
- *Social:* set each platform's timezone = Asia/Jerusalem (config, editable
  in the UI that already exists). Keep the existing per-platform slots + daily
  cap (3/platform) - this deliberately SPREADS the 10 stories across the day
  rather than dumping them at once (better reach, avoids the cap-3 spillover
  problem, council-endorsed). The owner sees + edits these in the same place.
- Fix the asset-gate timing (the 8 refusals): raise the autopilot/render lane
  gateRefusalHoldAfter (or make the hold non-terminal) so a story missing only
  thumbnails waits for the finisher (~24 min) instead of being held forever.

### Phase 4 - Enable full auto + post-publish safety
- Flip auto-publish on: *site first* (owner's own property, reversible), then
  social, once Phase 2 passes.
- *Post-publish monitoring:* watch the existing publisher result rows for
  strikes/failures/reports; auto-halt the drop (flip the kill switch) on a hard
  signal; wire the existing retractStory path as the cross-platform takedown so
  a bad post can be pulled everywhere fast.
- Keep the existing circuit breaker + the new hold-rate alert.

---

## Alternatives considered and rejected

- *Remove the judge entirely (full hands-off, no screen).* Rejected by owner +
  council: unattended posting under the brand to 4 platforms with zero screen is
  a real strike/ban and defamation risk.
- *Flip auto-publish on immediately after recalibrating (no ramp).* Rejected:
  the judge has 0 observed true positives; trusting it blind trades a harmless
  failure for a catastrophic one. Hence Phase 2.
- *Deterministic real-name blocklist as the primary gate (First Principles).*
  Rejected as the primary mechanism: AITA is saturated with names; a blocklist
  either over-holds again or misses. Use a stronger LLM judge + observability
  instead; keep deterministic checks only for clear signals (degenerate).
- *Israel drop via stories.publish_at + new cron (2A).* Rejected: schema +
  backfill + a new cron to reinvent scheduling that already exists.
- *Israel drop via "site" as a pseudo-platform in the scheduler (2C).* Strong
  option (max reuse, future multi-drop flexibility) but more code and it mixes
  site-status transitions into the social scheduler. Deferred: revisit if the
  owner later wants multiple drops/day or per-slot site editing.
- *Chosen (2B): time-gate the existing approve tick for site + config for
  social.* Least code, reuses the instant publish path + the DST-safe scheduler,
  no schema change, reversible.

---

## Security & safety (rule 13)

- *Attack surface:* unattended content going public + to 4 brand social
  accounts. Primary risks: (1) defamation via a hallucinated or real name paired
  with a damaging claim; (2) platform-policy strike -> account ban; (3)
  repetitive AI-generated content tripping spam filters at volume.
- *Controls:* the recalibrated judge (explicit danger taxonomy) + kill switch +
  hold-rate alert + post-publish monitoring + fast cross-platform retract.
  Validation ramp (Phase 2) proves detection before removing the human.
- *Fail closed on the dangerous categories only:* a judge outage still holds
  (keep the existing res.ok === false -> hold), but ordinary content publishes.
- *Secrets:* no new secrets. OPENAI_API_KEY is already set + Sensitive in
  Vercel. Do not log story bodies or keys.
- *Flagged, out of scope:* these stories are derived from real Reddit users'
  posts - an upstream copyright/ToS/defamation exposure that exists independent
  of this fix. Worth a separate review.

## Open questions

- Exact gpt-5.4-mini per-call price to confirm negligible cost (rule 8).
- Does the owner want the daily drop to also hold back social to the same
  morning window, or let social keep spreading across its slots (current plan)?
- Post-publish "strike" signal: which platform fields reliably indicate a
  takedown/strike vs a transient publish failure?

## Rollout / deploy safety (AGENTS.md)

- Build on a fresh branch off a *known-current* main (fetch + divergence-check
  both directions first). Do NOT build on feat/content-pagination.
- No push/merge/deploy without the AGENTS.md checks and explicit owner go-ahead.
- Phase 0 (observability + kill switch) ships first and is inert until enabled -
  safe to deploy early.
