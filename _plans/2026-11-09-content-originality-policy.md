# Content originality policy: clean-room generation and compliance checks

Status: approved by the owner on 2026-11-09. Branch `feat/content-originality-policy`.

## Goals

Move LoreWire from close Reddit retellings to an idea-only policy. New stories take
a premise only, are written by a step that never sees the source, and are checked
before publishing. Everything public about Reddit is removed from the site.

## Constraints and owner decisions

1. Checker: staged gate. Deterministic checks block now. Embeddings and the LLM judge
   are stored and shown at review until calibrated on about 50 stories.
2. Autopilot stays on. It keeps selecting from `reddit_source`.
3. Nothing is frozen. `reddit_source` stays usable. No new admin paste form.
4. Published catalog: label becomes "True stories from the internet" and every public
   Reddit reference is removed.
5. Reader submissions skip the rewrite and overlap checks. They keep moderation for
   identifying information and add an "I wrote this" confirmation.
6. New stories are labeled "Fictionalized story, inspired by real-life situations".

## Chosen approach

- `stages.extract_premise` turns the source into a validated 1-2 sentence premise.
- `stages.write_article` takes only the premise. Its signature cannot accept the source.
- The raw Reddit title no longer enters any prompt. `idea["headline"]` starts as the
  premise and becomes the branded title.
- New stories get a random non-Reddit id and slug, reused on job retries.
- Failed stories are saved for review without media spend. Retries are blind: the
  writer is never told what matched.
- `pipeline/compliance.py` holds every check. `src/lib/content-compliance.ts` ports the
  blocking subset so the publish gate can check final text, including edits, narration
  and social metadata. Shared cases in `pipeline/fixtures/compliance_cases.json` keep
  them in step.

## Rejected alternatives

- Every check blocking from day one: 0.85 is untested and an earlier LLM judge held
  about 100% of stories.
- Human premise bank with no stored source: cannot detect overlap or answer a
  complaint about a specific post.
- Python-only checks with a stored hash: an admin edit would need a new re-check queue.

## Database

Additive, applied on boot once deployed:

- `stories.content_origin`: `original` for clean-room stories, NULL for everything else.
- `stories.compliance_status`: `pass` or `fail` from generation.
- `submissions.own_work_confirmed_at`.
- New table `story_sources`: source text, URL, premise, full compliance report.

Existing stories are not modified. Slugs of existing stories keep their Reddit ids.

## Security and safety

- Sensitive data: strangers' post text and URLs. It lives only in `story_sources` and
  `reddit_source`, which public queries never read.
- The public story query no longer selects `reddit_id`, `source_url` or `payload`.
- Compliance reports quote source phrases, so they stay in `story_sources`. Logs carry
  counts and check names only.
- Source text in LLM prompts is delimited and marked as data. Premise output is validated
  before use, because a source could try to inject instructions.
- The gate fails closed: a clean-room story with no source record cannot publish.

## Costs (checked 2026-11-09)

- `text-embedding-3-small`: $0.02 per 1M tokens, about $0.00006 per story.
- `gpt-5.4-mini` judge: $0.75 in, $4.50 out per 1M tokens, about $0.01 per story.
  It is used because `gpt-5-nano` was the model behind the earlier over-holding.

## Known gaps and open questions

- Rule 6 says sources are selected manually. Autopilot still auto-selects, by owner
  decision, so the code and the written policy disagree on that point.
- The published catalog is still close adaptations. Its label and links changed; the
  text did not.
- Videos, captions and hashtags already on YouTube, Facebook and TikTok are not changed.
- Saved template overrides in the production settings table are not changed by this code.
- German legal review has not happened (copyright, UWG, personality rights).
- Advisory checks need calibration before they can block.
