# Content clarity bar — short script + article body

Date: 2026-06-28
Owner: Yoav
Status: approved, executing

## Why this exists

Manager feedback (in Hebrew, paraphrased): the *content* of our stories — both the short script and the article body — has to be understandable to anyone, even someone with no background on the niche or the source. He used "a child" and "Grandma Patricia" as the vibe, not literal personas. He also said some stories are hard to grasp the "catch" of, and that we should add what he called "pepper" (a Hebrew idiom for spice/interest) when the source is dry, so the post still pulls the reader in. Every story should always have (a) a concrete plot event and (b) a real curiosity-driving question.

He was explicit that this is about the **content**, not the speed of the video, not the visual presentation.

This work codifies that bar in the two prompts that govern voice for shorts and articles, so the LLM is forced to clear the same bar every run.

## Goals

- The short script and the article body both clear a "clarity for an outsider" bar: by the end, an everyday viewer with no background on the niche or source community can retell what happened in plain words.
- Every script is anchored to a concrete event that HAPPENED — never abstract reflection, never "people are talking about."
- Every script plants a real curiosity question the viewer needs answered, paid off across the body, handed to the poll at the end.
- When the source is dry or procedural, the LLM is told to lift it with sharp specifics (a vivid sensory detail, a real quote, a small human moment) — but **only from the source**, never invented drama.
- The hook-first / climax-first opening for the short is preserved unchanged. The clarity rule sits on top of the existing five-beat structure, not against it.

## Constraints

- Two files only: `pipeline/shorts_narration.py` and `pipeline/stages.py`. No new modules, no shared brand-voice extraction (premature — three short rules duplicated is fine).
- The JSON schema the short returns is unchanged. No downstream parser drift.
- The article prompt stays a single string; the new paragraph is folded in, the existing "don't moralize / don't invent" rules stay.
- Wording the manager used ("Grandma Patricia," "pepper") is rendered as the English spirit, not literal — confirmed with Yoav.
- No council pass — manager directive is the authority, scope is narrow.

## Chosen approach

### 1. Short — new `_clarity_block()` in `pipeline/shorts_narration.py`

Add a new block function alongside the existing `_structure_block`, `_brand_safety_block`, `_poll_block`, `_tone_block`, `_output_schema_block`. Insert into `system_parts` in `build_extraction_prompt` **between** `_structure_block(target_seconds)` and `_brand_safety_block()`. Order: structure → **clarity** → brand safety → poll → tone → schema. This reads to the LLM as: "here's the hook-first shape; here's the bar the whole script must clear on top of that shape; here are the guardrails."

Block content (final wording):

```
CLARITY — the script as a whole, not beat by beat:
  - The COLD OPEN still opens on the climax (see STRUCTURE). Clarity does
    NOT mean leading with context. It means that by the end of the RETURN
    beat, an everyday viewer with no background on the story — not online
    in this niche, not following the source community — could retell what
    happened in plain words. The hook earns the climax; the build delivers
    the plot.
  - Always anchor the script to a concrete event that HAPPENED — a specific
    action, moment, or reveal. Never abstract reflection, never 'people are
    talking about'. The viewer must finish knowing exactly what occurred.
  - Always plant a real curiosity question the viewer needs answered. Cold
    open raises it; build pays it off; CTA hands it to the poll. If a beat
    doesn't deepen the question or move toward the answer, cut it.
  - If the source is dry or procedural, lift it with sharp specifics: a
    vivid sensory detail, a real quote, a small human moment FROM the
    source. Defendable against the source — never invented drama.
```

### 2. Article — extract `_build_article_prompt()` in `pipeline/stages.py`

`write_article()` today inlines its prompt and pipes the result through `_clean_typography`. To make the new clarity paragraph testable without monkeypatching `llm.chat`, extract the prompt builder:

```python
def _build_article_prompt(idea: dict, research: dict) -> str:
    ...
```

`write_article()` becomes a one-liner over `_build_article_prompt` + `llm.chat` + `_clean_typography`. The new prompt embeds the clarity paragraph (matching the short's four rules in article voice):

```
Clarity bar: open on a vivid moment (keep the hook), but by the end an
everyday reader with no background on the story should be able to retell
what happened. Always anchor to concrete events that HAPPENED — never
abstract reflection or "people are talking about". Always plant a real
curiosity question early and pay it off in the body. If the source is
dry, lift it with sharp specifics: a vivid sensory detail, a real quote,
a small human moment from the source. Never invent drama beyond the
research.
```

## Alternatives rejected

1. **Edit the existing cold-open rule inside `_structure_block` instead of a new block.** Rejected: the cold-open rule already says "viewer with zero context — they should think 'I need to know how we got here', NOT 'I don't get it'." That covers beat 1 only. The manager's bar applies to the **whole script**. A new block makes that scope unambiguous to the LLM and to a future reader of the prompt code.

2. **Extract a shared `CLARITY_RULES` constant used by both files.** Rejected: two callers, three short bullets, and the article version needs to be phrased for a reader (not a viewer). Premature abstraction. A "stay in sync" comment in each file is enough until a third caller appears.

3. **Run the LLM Council on the wording before shipping.** Rejected: this is a manager directive with a tight scope, not an open architectural call. Council would create friction. If the wording underperforms in practice, that's the trigger to council the next revision.

## Open questions

- None right now. Wording was iterated to v3 with Yoav.
- After a week of shorts + articles generated under the new bar, evaluate whether any of the four rules is being ignored by the LLM (especially the "lift with specifics from the source" rule — easy to drift into invention). If so, tighten with a counter-example.

## Sections required by the global rules

### Security
N/A — prompt content changes only, no auth/data/identity surface touched. The "never invent drama beyond the research" line preserves the existing brand-safety guarantee against fabrication.

### Observability
The prompt builders are pure functions. No new logs needed — failures show up as test failures or in the LLM output, both visible in the existing pipeline run logs.

### Settings
None. The clarity bar is a brand-voice invariant, not a tunable knob. Exposing it as a setting would let it drift per-deployment, which defeats the purpose.

### Testing
- New `ClarityBlockTests` in `pipeline/tests/test_shorts_narration_structure.py` — asserts the prompt contains the CLARITY block, names the four anchor concepts (retell, concrete event, curiosity question, sharp specifics), and is inserted between STRUCTURE and BRAND SAFETY.
- New `BuildArticlePromptTests` in `pipeline/tests/test_stages.py` — asserts `_build_article_prompt(idea, research)` returns a prompt that includes the clarity bar tokens, the headline, and the research brief.
- Run: `python -m pytest pipeline/tests/test_shorts_narration_structure.py pipeline/tests/test_stages.py -v`

### Deploy
- Branch: `fix/homepage-rails-vote-and-top10` already checked out; this work is unrelated, so it goes on a new branch off `main`: `feat/content-clarity-bar`.
- Flow: open PR → CI runs the two affected test files → merge to `main` triggers the standard deploy.
- Production tracks `main`. No manual promotion. No force-push. Rollback is `git revert` of the merge commit on `main`.
- Will confirm branch + push plan with Yoav before pushing.
