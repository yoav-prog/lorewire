# Autopilot: gate-refusal hold + degenerate-story guard

Date: 2026-07-09
Base branch: `main` @ 48b016c
Branch: `fix/autopilot-gate-refusal-hold`
Builds on: `_plans/2026-07-08-autopilot-autonomous-mode.md`

## Incident that motivated this (2026-07-09, production)

The first real autonomous run pulled 10 sources at 14:14 UTC. Two earlier
autopilot stories in the review queue were degenerate generations:

- `idea_afa7867f3065` "NO STORY FOUND" - 108-char body saying "No story
  text was provided in the source". It had a rendered video, a hero image,
  and an enabled poll ("Skip this or rewrite from scratch?").
- `idea_40bf79d35050` "NO STORY, ONLY INSTRUCTIONS" - the source post was
  a prompt-injection attempt (instructions instead of a story); the
  generator refused to comply but wrote a meta-story about refusing.

Both passed the safety judge (they are "safe", just garbage - the judge
screens for harm, not quality). Both then failed `publishStoryIfReady` on
missing assets. The approve tick retried them every 2 minutes; each gate
refusal counted toward the circuit breaker; at 14:18:51 UTC the breaker
tripped and flipped autopilot off. Total autonomous uptime: 4 minutes.

Two distinct defects:

1. **A publish-gate refusal is retried forever and feeds the breaker.**
   One bad story kills the whole autonomous system. The breaker was
   designed for systemic publish failures, not per-story content problems.
2. **Degenerate "no story" generations reach the review queue as
   publishable.** If their assets had backfilled, both would have gone to
   the public site and every enabled social account.

## Goals

- One bad story can never disable autopilot.
- Degenerate generations can never auto-publish, and cost at most one
  approve-tick of attention.
- Transient asset gaps (thumbnail finisher still running) still resolve
  hands-off - no human pull for a story that becomes ready minutes later.
- Real systemic failures still trip the breaker and email the admin.

## Design

### 1. Gate refusal: defer, then hold (autopilot.ts)

In `runAutopilotApprove`, when `publishStoryIfReady` refuses (not the
`already_published` race, which stays "skipped"):

- Log a new `auto_gate_refused` decision row (observability trail; the
  decision column is unconstrained TEXT, so this is additive).
- Count the story's prior `auto_gate_refused` rows. Below
  `gateRefusalHoldAfter` (5), report the story as `deferred` and leave it
  a candidate - the next tick retries, giving the asset-backfill crons
  ~8-10 minutes to land the missing pieces.
- At the threshold, log `auto_held`: the story leaves the candidate set
  (same exclusion the judge-hold uses), shows the "Held by safety check"
  badge, and waits for a human.
- Gate refusals no longer touch the breaker at all. The breaker counts
  only thrown exceptions (DB down, network dead) - actual systemic
  failures.

### 2. Degenerate-story guard (autopilot.ts)

`screenStoryForAutopilot` gets a deterministic pre-check before the LLM
call (`detectDegenerateStory`):

- tag-stripped body under 250 chars -> hold ("too short to be a real
  story"; no legitimate LoreWire story body is remotely that short),
- title matching /\bNO STORY\b/i -> hold.

Held stories use a new judge category `not_a_story`, cost zero LLM calls,
and land in review for the human via the existing auto_held path.

The judge prompt also gains a hold criterion for phrasings the heuristics
miss: text that is not actually a retellable story (placeholder/apology
about missing source material, meta-commentary about instructions).

### 3. Silent no-op warning (autopilot.ts)

When an approved story schedules zero social posts (master switch off, all
platforms disabled, or every platform reported no_slot), `console.warn`
with the per-platform outcomes. Previously this case logged as a success.

## Rejected alternatives

- **Hold on first gate refusal.** Simplest, but a story whose thumbnail
  finisher is still running would go to a human for no reason, quietly
  eroding hands-off operation. The deferral window fixes the common
  transient case.
- **Exact title matching for degenerate stories.** "NO STORY FOUND" is
  LLM-improvised, not a pipeline constant; the next one will be worded
  differently. Body-length heuristic + judge-prompt criterion are robust
  to phrasing.
- **Pipeline-side (Python) generation validation.** The right long-term
  fix (saves render cost on garbage), but it touches the generator and
  its test suite - a second concern. Recommended follow-up, not built
  here.

## Architecture

No new layers. All logic stays in `lib/autopilot.ts` (the single owner of
approve-tick policy); `publish-scheduler.ts` only widens the decision
union type. UI and route changes are display-only pass-throughs.

## Security / safety (rule 13)

- Publish gets strictly harder, never easier: every changed path ends in
  "hold for a human" instead of "retry" or "publish".
- The breaker still exists for systemic failures; fail-closed judge
  behavior untouched.
- The degenerate guard runs before the LLM call, so prompt-injection
  artifacts like "NO STORY, ONLY INSTRUCTIONS" are held without giving
  the injected text another model to talk to.

## Observability (rule 14)

- `[autopilot approve] publish gate refused` warn now carries
  `attempt` and `held` fields.
- `[autopilot safety]` info logs degenerate holds with the reason.
- New warn when an approved story queues zero social posts, with
  per-platform outcomes.
- `auto_gate_refused` decision rows give a queryable per-story trail.

## Settings (rule 15)

No new settings. The deferral threshold (5 ticks) and degenerate body
minimum (250 chars) are code constants: they are safety-mechanism tuning,
not user preference, and exposing them invites turning the guard off.

## Testing (rule 18)

`autopilot.test.ts`, all against the real store, LLM/publish/email mocked:

- Gate refusal defers without touching the breaker (fails on old code:
  old behavior counted it as a breaker failure).
- Gate refusal holds after the threshold and leaves the candidate set.
- Breaker still trips on 3 consecutive publish exceptions (rewritten from
  gate refusals to thrown errors).
- `detectDegenerateStory` unit cases (short body, NO STORY title, healthy
  story).
- Degenerate story held with zero LLM calls, end to end through the
  approve tick.
- Existing suites re-run: autopilot, render-scheduler, publish-scheduler.

Fixture note: test stories previously used `<p>Body</p>` bodies; they now
use realistic-length bodies so they represent real stories and pass the
degenerate guard.

## Deploy (rule 19)

- PR from `fix/autopilot-gate-refusal-hold` into `main`; Yoav merges;
  merge auto-deploys production via Vercel (standard flow).
- Production healing after deploy: send the two degenerate stories back
  to draft, then re-select Autonomous on /admin/scheduler (mode change
  resets the breaker). Nothing else needed - the pulled jobs keep
  rendering while autopilot is off and get picked up on the next tick.
- Rollback: revert the merge commit; behavior returns to pre-fix (jam +
  breaker trip), no data migration to unwind.

## Open questions / follow-ups

- Python generator should fail a job that produced a no-story output
  instead of rendering it (saves the render cost). Follow-up PR.
- Volume: autopilot pulls 10/day but each platform defaults to 3 slots
  and a 3/day cap; overflow beyond the 14-day slot horizon permanently
  skips that platform for that story. Owner decision needed: more slots
  per day or a lower daily limit.
- TikTok is off and its credentials fail (unauthorized scope / URL
  ownership); needs a re-auth before enabling.
