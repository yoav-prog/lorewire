# Autopilot: fully-autonomous (raw) mode + configurable source tier

Date: 2026-07-08
Base branch: `main` (autopilot shipped to main via `feat/scheduler-v2-autopilot-slots`)
Builds on: `_plans/2026-07-02-scheduler-autopilot-and-flexible-slots.md`

## Goal

Let autopilot run fully hands-off: on the 2-minute cron it pulls Reddit
sources up to a daily limit (owner set 10), renders them, and auto-publishes
the clean ones to the site + all four socials with no human click and
WITHOUT waiting for the human review queue to be empty. The safety judge
stays (owner chose "screened"). This removes the two deliberate brakes from
the 2026-07-02 design: the empty-queue gate and the STRONG-only tier.

## What the owner decided (2026-07-08)

The owner was shown the full council verdict below and a strongly-recommended
safer alternative ("autonomous + safety net": delay buffer on social posts +
daily digest email with one-click retract + content-aware breaker). The owner
chose **raw autonomous** explicitly, twice, with the risks in front of them.
That is their call to make; this plan records it faithfully and does not
silently re-add the rejected guardrails.

## Council verdict (design pressure-test, 2026-07-08)

Five-advisor council + 3 anonymized peer reviews. Consensus:

- **The judge's role silently flips from second line to sole gatekeeper.**
  One gpt-5-nano call is now the only screen between adversarial Reddit UGC
  (prompt-injection risk) and four brand accounts. It only sees the
  rewritten text, so it cannot know the source was fabricated, defamatory,
  or about a real named person / suicide.
- **The circuit breaker measures the wrong signal.** It trips on 3
  consecutive publish *failures* (HTTP), not content quality. A
  confident-but-wrong publish returns 200 and never trips it.
- **Supply, not the gate, likely caps 10/day.** Widening `min_strength` to
  "all" is the real risk-bearing decision; it is stacked in the same change.
- **Retract is theater on TikTok** (no delete API). The one irreversible
  surface is unattended.
- **Platform account-termination is the likeliest catastrophic outcome**
  (peer-review catch): 10/day reworded Reddit posts across four platforms is
  textbook inauthentic-behaviour / undisclosed-synthetic-media, which gets
  ACCOUNTS banned, killing all distribution regardless of per-post safety.
- **EU AI Act Art. 50 / DSA / GDPR** (peer-review catch): operator is
  Traffic.Club IT GmbH (see the Imprint). Auto-published AI content about
  identifiable people triggers transparency-labelling + erasure duties.
- **Idempotency was raised but is already handled** in this codebase:
  `ON CONFLICT (reddit_id) WHERE status IN ('queued','processing')` on
  enqueue and `ON CONFLICT (story_id, platform) WHERE state IN (active)` on
  publish. No double-post bug. Residual: minor daily-limit overshoot if two
  cron ticks overlap (bounded by budget cap) — accepted, not engineered.

## Rejected alternatives

- **Autonomous + safety net** (recommended, declined by owner): site
  publishes instantly (reversible), social posts route through the existing
  slot scheduler with a delay buffer + a daily Brevo digest email listing
  what published/held with one-click retract; breaker also trips on
  retract/hold-rate spikes. Delivers hands-off with a witness. Declined.
- **Keep the human gate, kill the grind** (declined): judge pre-sorts
  clean/hold, one-click bulk-approve, ~2 min/day. Lowest risk. Declined.
- **A new AI-disclosure default-on**: declined by owner intent (captions
  stay untouched); shipped as a default-OFF setting so it is one flip away
  when enforcement bites.

## Design (raw autonomous)

Minimal, additive, backward-compatible. Existing off/shadow/live behaviour is
unchanged; the safety judge, breaker, stale-GC, and retract are untouched.

### 1. Configurable source tier (increment 1, ships first, no publish-path code)

- New setting `autopilot.min_strength` (default `"strong"` — zero behaviour
  change for existing users). Reader `getAutopilotMinStrength()` in
  `lib/autopilot.ts`, mirroring `getEligibilityMinStrength()` in
  `render-scheduler.ts`; unknown value falls back to `"strong"` (never
  silently widens).
- `runAutopilotPull()`: replace hard-coded `selectRenderCandidates(want,
  "strong")` with the setting.
- UI: a `SettingSelect` in the Autopilot section — "Which sources autopilot
  may use": Strong only / Strong + Medium / All. Copy notes wider = more
  volume, lower average quality; the judge still screens every story.

### 2. New `autonomous` mode (increment 2)

- `AutopilotMode` type: add `"autonomous"`.
- `getAutopilotMode()`: parse `"autonomous"`.
- `setAutopilotModeAction()`: accept `"autonomous"` (still resets breaker).
- `AutopilotModeSelect.tsx`: 4th button. Copy is explicit: "Runs
  continuously and publishes without waiting for your review queue to empty.
  The safety check still screens every story; doubtful ones still wait for
  you. Everything else is unattended."
- `runAutopilotPull()`:
  - In `autonomous`, skip the `humanReviewDepth > 0` empty-queue gate.
  - Headroom scoped to autopilot's OWN footprint so a manual backlog can't
    starve it: `autopilotReviewDepth = totalInReview - humanReviewDepth` and
    an autopilot-only pending count (new `countPendingStoryJobs` filter or a
    small dedicated query). `live` keeps today's all-review headroom.
- `runAutopilotApprove()`: run when `mode === "live" || mode ===
  "autonomous"` (was `!== "live"` early-return).
- Breaker, judge, budget gate, GC: unchanged.

### 3. AI-disclosure — DEFERRED to a follow-up PR

Considered wiring a default-off `publisher.ai_disclosure.enabled` +
caption suffix. Deferred: it touches all four proven platform publishers
(a second concern in one PR, against commit hygiene and the council's
"don't touch the publish path" caution), and a setting nothing reads is
dead code. Recommended follow-up given the EU AI Act Art. 50 exposure on
the German operator. Not built here.

## Security / safety (rule 13)

- Attack surface unchanged: cron is `CRON_SECRET`-Bearer gated; all controls
  are settings behind `settings.manage`; default mode off.
- The judge remains fail-closed (outage / malformed = hold).
- Breaker still auto-disables + emails on repeated publish failures.
- KNOWN, OWNER-ACCEPTED residual risks (see council): sole-gatekeeper judge,
  breaker blind to content quality, TikTok irreversibility, platform-ToS /
  account-ban exposure at volume, EU AI Act / GDPR exposure on real-person
  content. Documented here so they are a decision on record, not a surprise.
- Budget cap on the Reddit Sources page governs spend; at 10/day set it to
  cover ~$5–12/day or autopilot stalls at `budget_exhausted`.

## Lazy-user walkthrough (rule 10)

Scheduler page → Autopilot section → click **Autonomous** (4th button, end of
the ramp = most hands-off). "Stories per day" slider already there (set 10).
"Which sources" dropdown right below. Status line shows N/day pulled +
auto-published + held. "Published by autopilot" list with Retract stays.
Nothing else to configure; it runs on the existing 2-min cron.

## Verification

- Unit tests in `autopilot.test.ts`: autonomous ignores backlog; approve runs
  in autonomous; `min_strength` widens candidate selection; headroom scoped
  to autopilot footprint (manual backlog does not starve autonomous);
  breaker still trips; unknown mode still reads off.
- `setAutopilotModeAction` accepts the 4th mode; rejects garbage.
- Typecheck + full `autopilot.test.ts` + `render-scheduler.test.ts` green.
- Drive one end-to-end tick locally (POST `/api/autopilot_tick`) with a
  seeded strong+medium pool and mode=autonomous; assert it enqueues past a
  non-empty manual review queue.

## Open questions

- Confirm the budget cap is set for 10/day before flipping to autonomous.
- AI-disclosure: leave off, or turn on now given the German operator?
