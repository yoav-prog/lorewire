# LoreWire content policy

This file is the single source of truth for what LoreWire may publish. The
generation prompts and the compliance checker enforce these rules. Change a rule
here first, then change the code that enforces it.

1. **Premise only.** A story may take only the general situation from a source
   (for example, "a coworker labels her lunch with escalating notes"). Nothing
   else.
2. **No copied text.** No sentences, phrases, or quotes from the source,
   including dialogue, notes, texts, or signs quoted in the source.
3. **No copied structure or details.** No reuse of the source's specific details
   (numbers, objects, places, odd specifics), sequence of events, escalation
   beats, twist, or ending. Names, dialogue, plot developments, and ending must
   be invented by us.
4. **No identifying information.** No usernames, real names, employers,
   locations, or anything that could identify the poster or people in their
   story.
5. **Honest labeling.** Never label a story "True Story" or present it as a
   specific person's account. Use "Inspired by real stories from the internet"
   (or similar). Do not link to or name the source thread publicly.
6. **Sourcing.** Sources are selected manually or come from reader submissions.
   No automated scraping of Reddit, or of Reddit content via search engines or
   third-party scrapers.
7. **No undisclosed product placement.** Stories must not mention brands, apps,
   or products unless that's required and disclosed.

## How the rules are enforced

| Rule | Enforcement |
|---|---|
| 1 | `stages.extract_premise` reduces the source to one or two abstract sentences. `stages.write_article` receives only that premise and never the source. |
| 2 | Blocking checks: shared word runs and quoted strings. |
| 3 | Advisory for now: sentence embeddings and an LLM judge, shown at admin review until calibrated. |
| 4 | Blocking checks: usernames and proper names that appear in the source. |
| 5 | Blocking check on story text and social metadata. |
| 6 | The automated Reddit scraper was removed from the code. |
| 7 | Advisory: brand and product names are flagged for human review. |

Thresholds live in `pipeline/compliance.py` and
`lorewire-app/src/lib/content-compliance.ts`. Both run the same cases from
`pipeline/fixtures/compliance_cases.json`.

The blocking checks run again at publish time against the final text, so an edit
made after generation cannot bypass them.

## Label in use

New stories written under this policy show "Fictionalized story, inspired by
real-life situations".

## Reader submissions

A reader's own story is not rewritten and is not compared against a source. It
still goes through submission moderation, which rejects identifiable real people,
and the reader must confirm the story is their own before submitting it.
