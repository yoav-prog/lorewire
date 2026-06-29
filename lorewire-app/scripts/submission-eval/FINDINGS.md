# Phase 0 eval findings — submission moderator

Date: 2026-06-29. Plan: `_plans/2026-06-29-user-submitted-stories.md`.
Dataset: 43 labeled submissions (25 EN, 18 HE) across clean own-story, fiction,
identifiable real-person, ambiguous real-person, spam, hate, sexual, threats /
self-harm, low-effort, off-policy, and prompt-injection. Policy: `./POLICY.md`.
Pipeline: cheap pre-checks, free OpenAI Moderation API (`omni-moderation-latest`),
then a `gpt-5-nano` policy judge with a real-person signal and confidence-based
hold routing. Full report + per-item results in `out/`.

## Verdict: GO with gpt-5-nano. The real-person gate holds in both languages.

The one thing Phase 0 existed to answer: can we reliably keep a submission that
identifies a real, findable third party out of `approve`, in English and Hebrew,
without strangling clean own-stories. Yes.

## The number that matters

**Real-person recall: 100% EN, 100% HE.** All 9 identifiable-real-person
submissions (full names, public figures, a handle, an address, named-person
accusations) were caught (7 reject, 2 hold). **Zero were approved.** Each approved
real-person submission would have been a potential published, AI-narrated
defamation, so this is the load-bearing result and it is clean.

**Zero over-blocks.** All 13 clean own-stories with generic relationships ("my
husband", "my roommate", "my boss", "my manager") were correctly approved, not
mistaken for real-person content. The check is precise, not trigger-happy.

## The judge is load-bearing here (unlike comments)

With `--no-judge` (Tier 1 only), real-person recall collapses to **0% in both
languages** — all 9 approved. The free Moderation API classifies toxicity, and
naming a real person is not toxicity, so Tier 1 is structurally blind to this
policy. In the comments feature Tier 1 at least carried severe toxicity; here it
carries almost nothing. **Run the judge on everything Tier 1 does not quarantine or
reject — it is the gate, not a backstop.**

## The two "critical misses" are not safety holes

The harness flags any gold reject/quarantine that got approved. Two fired; neither
is a real failure:

1. `en/sexual` "Something that happened at a party" — approved. The dataset body is
   a **placeholder** (`[explicit sexual description...]`) with no actual explicit
   text, so there was correctly nothing to catch. This means **sexual-content
   recall is UNMEASURED**, not failing (see gaps below).
2. `he/off_policy` "שאלה קצרה" — a benign "which phone should I buy?" framed with
   two options. Approved. Off-brand, not harmful. A scope-definition nit, not a
   safety problem.

The genuinely dangerous categories had zero harmful approvals: real-person 0
approved, hate 0 approved (1 reject + 1 quarantine), threats/self-harm 0 approved
(2 quarantine + 1 reject), spam 0 approved (3 reject + 1 hold).

## Tuning findings to carry into Phase 2

1. **Ambiguous real-person is under-held.** All 3 `real_person_ambiguous` items
   ("my manager Mike", "my professor for CS101 at the state university") were
   approved, not held. They are genuinely low-risk (no findable individual, mild
   claim), so this is a policy-strictness choice, not a safety hole. But this is the
   one axis to be conservative on. Recommendation: add a lightweight NER / proper-
   noun person pass so that **any named individual paired with a claim** is routed
   to at least a hold, even on a first name. Do not rely on the judge's own
   restraint here.
2. **Sexual recall is unmeasured** because the test cases were placeholdered (a
   deliberate choice to avoid authoring graphic content). Close this before trusting
   the auto-path: add realistic-but-clinical sexual cases, or lean on Tier 1, which
   is strong on sexual / sexual-minors and already routes the latter to quarantine.
3. **Low-effort is rejected, not held** (gold said hold). Acceptable — rejecting
   "AITA lol idk" with a fix-and-resubmit nudge is arguably better than holding it.
   Wire the deterministic length pre-check to make this deterministic and free.
4. **Off-policy scope is loose.** The judge will approve a two-option product
   question as a "dilemma". Tighten the prompt to require a personal or clearly
   fictional *story*, not a bare question, if scope creep shows up in real traffic.
5. **Hebrew exact-match (55.6%) trails English (72%)**, but the entire gap is in the
   subjective taste categories — the safety gate (real-person, hate, threats) is
   100% in Hebrew. Same shape as the comments Step 0: strong on safety, opinionated
   on noise. Keep watching Hebrew over-blocking in production logs.
6. **Confidence hold-routing barely fired** (the judge is decisive). It stays in as
   the safety net the comments eval validated; no harm, occasional save.

## Recommended starting settings (tune from logs)

- Judge: `gpt-5-nano`, `reasoning_effort: minimal`, Structured Outputs (strict
  `json_schema` with `identifies_real_person` + `real_person_kind`), omit
  `temperature`, `max_completion_tokens` ~512 in prod (2000 was generous here).
- Run the judge on everything Tier 1 does not quarantine/reject. Tier 1 cannot
  enforce this policy alone.
- Real-person override in code: `public_figure` or `private_identifiable` -> reject;
  `ambiguous` -> hold. Add the NER pass (finding 1).
- Tier 1 quarantine categories: `sexual/minors`, `harassment/threatening`,
  `hate/threatening`, `self-harm/intent`, `violence` at >= 0.5 -> non-discretionary
  path. Tier 1 fast-reject: API `flagged` or max toxicity >= 0.5.
- Hold routing: approve/reject with judge confidence < 0.6 -> hold.
- Pre-filters: body length floor -> low_effort; URL present -> spam emphasis.

## Reproduce

```
node scripts/submission-eval/run-eval.mjs                 # full pipeline
node scripts/submission-eval/run-eval.mjs --hold-below=0   # raw judge, no hold routing
node scripts/submission-eval/run-eval.mjs --no-judge       # Tier 1 only (real-person recall -> 0%)
```

Cost of one full run: ~$0.01 (free Tier 1 + ~43 gpt-5-nano judge calls).
