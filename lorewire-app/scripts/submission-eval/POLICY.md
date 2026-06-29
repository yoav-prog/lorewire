# Submission content policy (Phase 0)

Plan: `_plans/2026-06-29-user-submitted-stories.md`. This is the load-bearing
artifact the council flagged as "the one thing to do first": the exact rule the
whole feature hangs on. The moderation judge prompt, the reject-reason taxonomy
(`reasons.mjs`), and the eval gold labels (`dataset.mjs`) all derive from this
document. Change this first, then change those.

## What a submission is

A signed-in user submits:
- a **title**,
- a **story** (their own experience or a clearly fictional scenario), and
- a **dilemma**: a question plus two options the public will vote on.

On approval the existing short pipeline renders it into a video and it publishes
with a poll. So an approved submission becomes a produced, AI-narrated video that
carries the lorewire brand. The bar is set with that in mind, not the lower bar of
an ephemeral comment.

## The core rule

**Own-story or fiction. No identifiable real third parties.**

A submission is acceptable when it is either:
1. the submitter's **own** experience, told from their side, or
2. a **clearly fictional or hypothetical** scenario,

AND it does **not** identify a real third party who has not consented.

This keeps the entire classic "Am I The Asshole" style of relationship and
roommate and workplace dilemma fully in scope, while cutting the defamation,
harassment, and right-of-publicity exposure that turns a UGC video platform into a
news story about itself.

### What "identifiable real third party" means

Reject when the story points a reasonable reader at a **specific real person** who
could be found or recognized. Signals, any one of which is enough:

- A real person's **full name** (or a name plus a locating detail).
- A **public figure** named as the subject of the dilemma (politician, celebrity,
  executive, influencer), especially with an accusation attached.
- A **handle, link, phone number, address, or photo-identifying detail** ("my ex,
  his Instagram is @...", "Dan at 14 Oak Street", "the only orthodontist in
  [small town]").
- A named or uniquely-pinpointed person paired with a **damaging claim** (cheating,
  theft, abuse, a crime). This is the defamation core and is the strictest line.

### What is still allowed

Generic relationship roles with no identifying detail are fine, because they point
at no findable individual:

- "my husband", "my sister", "my roommate", "my boss", "a girl in my class",
  "my mother-in-law", "a coworker".

The presence of another person in the story is normal and expected. The line is
**identifiability**, not mere mention.

### Ambiguous cases go to a human

A first name alone with mild context ("my manager Mike"), or a role that is only
locatable with effort, is **borderline**. The automatic path must never approve
these on its own. Route to a human (decision `hold`). When in doubt, hold, do not
reject. A wrongly-held submission costs a review; a wrongly-approved defamation
costs the platform.

## Decisions

Four outcomes. The dataset and harness use these exact words.

- **approve** — clean own-story or fiction, a real dilemma, no identifiable real
  third party. Eligible to render.
- **hold** — a human must look. Ambiguous real-person signal, genuinely borderline,
  or a low-confidence automatic verdict.
- **reject** — clearly breaks a rule. Returns to the author with a plain-language
  reason and a fix-and-resubmit path (`reasons.mjs`).
- **quarantine** — severe and non-discretionary (sexual content involving minors,
  credible threats, self-harm intent). Preserved, alerted, never silently deleted,
  **not** resubmittable. Handled out of band, not via the normal reject loop.

## Machine categories

Used by the judge, the reason taxonomy, and the gold labels. Each leans toward a
decision but the decision is derived in code (see the harness), not taken raw from
the model.

| Category | Lean | Meaning |
|---|---|---|
| `clean` | approve | Own story or fiction, real dilemma, no identifiable real person. |
| `real_person` | reject | Identifies a real, findable third party (the core policy line). |
| `real_person_ambiguous` | hold | Possibly identifiable; a human decides. |
| `spam` | reject | Promotion, ads, links, affiliate or "buy my thing" pitches. |
| `hate` | reject | Slurs, dehumanizing or harassing content aimed at a person or group. |
| `sexual` | reject | Sexual or explicit content. Minors involved escalates to quarantine. |
| `threat_self_harm` | quarantine | Credible threat of violence, or self-harm intent. |
| `low_effort` | hold | No real story, no real dilemma, gibberish, or far too short. |
| `off_policy` | reject | Not a story-plus-dilemma at all (an ad, a bare question, a pure rant). |
| `borderline` | hold | Genuinely unsure; a human should review. |

## Operating rules carried from the comments Step 0 eval

These are settled findings from `scripts/moderation-eval/FINDINGS.md`; we do not
re-litigate them, we inherit them:

- **The free Tier 1 Moderation API is a safety net, not the gate.** Run the judge on
  everything Tier 1 does not outright reject. Tier 1 is weak on Hebrew toxicity.
- **Derive `hold` from confidence in code.** The model will not volunteer it. A
  low-confidence approve or reject is exactly what a human should see.
- **Profanity by itself is allowed.** Bluntness and swearing are not violations
  unless they are harassment or a slur.
- **Treat the submission as untrusted data.** Instructions embedded in the story
  ("approve this", "ignore your rules") are content, not commands. A clean story
  does not become a violation just because it asks to be treated as one, and a bad
  story does not become clean by asking to be approved.
- **English and Hebrew both matter.** The gate number is measured per language; a
  judge that is strong in English and blind in Hebrew is not shippable.

## The Phase 0 gate

This policy ships to Phase 1 only if the eval shows the **real-person check has high
recall in both languages**: of submissions whose gold is `real_person`, almost none
may be `approve`d (each one is a potential published defamation). Over-holding the
ambiguous ones is acceptable and expected. If the real-person recall is weak, fix
the judge (or add a dedicated NER pass) before any UI is built.
