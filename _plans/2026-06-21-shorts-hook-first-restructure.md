# Shorts Hook-First Restructure (Cold-Open Climax + Tight Poll Coupling)

Date: 2026-06-21
Status: Draft, awaiting approval
Owner: Yoav
Branch target: new `feat/shorts-hook-first` branched off `feat/multi-platform-shorts-publisher`
Supersedes: the 5-vibe narration presets in `pipeline/shorts_narration.py` (the file stays, the registry contents get rewritten).

## 1. Goal

Rebuild how every Lorewire short is written, sized, and ended so retention is dragged up from the first second and the on-site poll is the natural payoff of the social-clip hook. Every short opens on the climax beat, rewinds to the start, builds back to the climax, then hands the viewer the poll question that the story has been daring them to answer.

Three deliverables:

1. **A single hook-first script structure** that replaces the five existing vibe presets. One template, internally tuned, emotionally dense but social-safe.
2. **Tight coupling between the short and its poll** — the LLM pass that drafts the script also drafts (or refines) the poll question and sides in the same call, so the cold-open beat, the closing CTA, and the on-page vote all reinforce one phrase.
3. **A per-story full-rebuild capability** ("Regenerate v2") that re-runs the entire stack — article body, poll, hero, thumbnail, VO, alignment, short — for stories generated before this plan ships, with an explicit cost-gated bulk action.

The current 5-vibe system optimizes for variety but flattens retention; every short opens on setup. The new system trades variety for a single, sharp template tuned to the format's actual physics: viewers decide to stay or swipe inside 1.5 seconds.

## 2. Constraints and decisions (locked at intake)

- **Hook style is the conflict moment**, not the vote question or a stock shocked line. We open on the most charged beat in the story — the message, the door slam, the price tag — and rewind. The question lives at the end card, where it pays off.
- **All 5 narration vibes get replaced by one structure.** The `NARRATION_STYLES` registry shrinks to a single entry. The internal *tone* knob (calmer vs more urgent) is exposed as a parameter inside the one structure, not as a separate preset.
- **Hard brand-safety rules in the system prompt**, enforced in every generation:
  - No all-caps shock language in the VO (`YOU WON'T BELIEVE`, `SHE DID WHAT`).
  - No moralizing or villain-naming in the hook. The cold open shows the conflict, does not tell the viewer who is wrong. The poll asks them — the short must not pre-answer.
  - No financial, medical, or identity specifics that could identify real people. Mirrors the article-level redaction.
  - No profanity in VO or burnt-in text. Required for YouTube/TikTok monetization and IG/FB reach.
- **Script + poll are generated together in one LLM call.** Output JSON shape gains `poll: {question, option_a, option_b}` so the climax phrasing, the end-card hook line, and the poll question can be tuned against each other in a single pass.
- **Existing renderer code (`question_card.py`, scene planner, shorts_render) stays put.** This plan changes what gets generated, not how it gets rendered. The end card already does the right thing — it just needs better inputs.
- **Build it, don't rent it** (per memory). No third-party script writer, no SaaS hook generator.
- **Length budget stays 45s standard / 62s extended.** The new structure must fit the same word budgets (~105 / ~145 words at 2.33 w/s). No silently bumping duration to make the structure fit — the structure adapts.

## 3. The new script structure

Five beats. Every short. The LLM is constrained to produce exactly these in order. Word budgets are guidance per beat, hard cap on total.

| # | Beat | Length | Job |
|---|------|--------|------|
| 1 | **Cold open** | 1.5–3s, 4–8 words | Drop the viewer inside the climax. Action or sensory detail only. No judgment, no setup, no "imagine if". |
| 2 | **Rewind cue** | 0.5–1.5s, 2–5 words | A short pivot that signals time-jump. ("This started 6 days earlier." "Here's how she got here.") The viewer now knows they will see the lead-up. |
| 3 | **Build** | 25–40s, 60–85 words | The story from the top, told tightly. Every sentence earns its place by raising the stakes or planting a detail the climax will pay off. |
| 4 | **Return to climax** | 4–6s, 10–14 words | Land on the same beat we cold-opened with — now with full context behind it. The emotional hit is the *re-encounter*, not a new event. |
| 5 | **CTA / poll handoff** | 2–4s, 5–10 words | One line that names the dilemma in the viewer's words and points to the poll. Must echo (not duplicate) the poll question's framing so the end card feels like the continuation, not a reset. |

The opening climax frame must be **visually arresting and legible in isolation** — a confused viewer at 1.5s thinks "I need to know how we got here," not "I don't get it, swipe." The script planner sets `cold_open_visual_brief` (a one-sentence description) that the scene planner uses to generate scene 1.

### What the JSON output looks like now

```json
{
  "title": "<6-8 word title>",
  "hook": "<the cold-open words, beat 1>",
  "rewind": "<the rewind cue, beat 2>",
  "build": "<the build narration, beat 3>",
  "return": "<the return-to-climax line, beat 4>",
  "cta": "<the closing line, beat 5>",
  "short_script": "<beats 1-5 concatenated with single spaces, the canonical spoken text>",
  "cold_open_visual_brief": "<one-sentence visual description of the climax frame>",
  "payoff": "<copy of return + cta for back-compat with renderer>",
  "word_count": <integer>,
  "poll": {
    "question": "<≤80 chars, neutral framing, no answer leaked>",
    "option_a": "<≤24 chars>",
    "option_b": "<≤24 chars>"
  },
  "tone_knob": "<one of: calm-curious | tense | wry | warm-sad>"
}
```

`short_script` stays as the canonical field the downstream pipeline already consumes — the new fields are additive. `payoff` is maintained as a shim equal to `return + " " + cta` so any code currently reading `payoff` keeps working.

## 4. Brand-safety enforcement (system prompt)

Three layers of defense:

1. **Prompt-level**: the system prompt names the banned patterns explicitly with examples of bad and good lines side by side. The model gets the rule and a concrete failure case.
2. **Boundary validator** (`pipeline/shorts_narration.py::validate_script(payload)`): regex + simple checks on the parsed JSON. Rejects on all-caps words > 3 chars, profanity from a list, length overflow >120% of budget, or missing required fields. Fails closed — caller decides to retry or surface to admin.
3. **Length truncation safety**: if the LLM returns a script that fits structure but exceeds the duration cap, the validator rejects rather than truncating — truncation breaks the climax landing. One retry with a tightened budget instruction, then surface to admin.

Profanity list is conservative and English-only in v1 (this is what we ship to). Kept in `pipeline/shorts_safety.py` as a single source so future expansions (caption transformer, article redaction) can reuse.

## 5. Pipeline integration

Touchpoints, in order:

1. **`pipeline/shorts_narration.py`**: replace the 5-entry `NARRATION_STYLES` dict with a single `HOOK_FIRST_STYLE`. Rewrite `build_extraction_prompt` to produce the new 5-beat structure and the new JSON shape. Add `validate_script`. The `NarrationStyle` dataclass gains nothing new — the prompt does the work.
2. **`pipeline/shorts.py::build_plan_prompt`**: scene planner now receives `cold_open_visual_brief`. Scene 1 is the climax frame, scenes 2..N-1 are the build, scene N returns to the climax composition. Add a `is_climax_frame: bool` marker on scenes 1 and N so the renderer can apply any future "first frame thumbnail / hold longer" treatment without re-deriving it.
3. **`pipeline/shorts.py::generate_short_assets`**: the function that orchestrates narration → scene plan → images. After narration runs, it now also writes the drafted poll into the `polls` table for the story **only if no enabled poll exists yet**. If one exists, the new draft goes into a `polls_draft` shadow row (new table — see §8) so admin can compare and adopt. The auto-draft button in the admin editor keeps working untouched.
4. **`pipeline/question_card.py`**: no code change. It already reads the enabled poll and produces the burnt-in card. With tighter coupling, the card text will *match* the short's CTA line, but the resolver is the same.
5. **`pipeline/shorts_auto.py`**: no logic change, but now auto-shorts triggers a poll draft as a side effect of script generation. Documented in the file header.
6. **Caption-hook injection** (per `_plans/2026-06-16-multi-platform-shorts-publisher.md` §3.F4): the `{poll_hook}` slot already exists; it'll naturally read the new poll. No code change.

## 6. Per-story full rebuild ("Regenerate v2")

New admin capability for backfilling stories generated before this plan ships. Two surfaces:

- **Per-story button** in `/admin/stories/[id]` editor: "Regenerate full v2 stack". One click, confirmation modal showing the estimated cost (computed live from the current model registry pricing — see §10), runs the entire pipeline.
- **Bulk action** in `/admin/stories` list: select N stories, "Regenerate full v2 stack". Confirmation modal shows total estimated cost and an explicit slider for how many to run concurrently (default 4, cap 8 to respect the existing image-API budget per `pipeline/shorts.py:31-32`).

What "full v2 stack" actually re-runs, in order:
1. Article body (LLM, gpt-5.4-mini) — same writer pipeline, fresh draft. Slug unchanged, `body_revision` incremented, old body archived in `article_revisions`.
2. Poll question + sides (LLM, drafted as part of step 4 — but for already-voted polls see §7).
3. Hero image (gpt-image-2 t2i).
4. Short narration (hook-first structure) + poll draft, single LLM call.
5. Scene plan + per-scene images (gpt-image-2-i2i × ~12).
6. Thumbnail (selected frame or new gpt-image-2 t2i — TBD per §11.O3).
7. Voiceover (Chirp 3 HD by default, ~120s clip).
8. Read-along forced alignment (deterministic, free).
9. Short render (Cloud Run, existing path).
10. Question card baked at render time from the refreshed poll.

**Single transaction guard**: if any step fails, the prior version stays live. The new artifacts land in shadow paths (`stories.id + "/v2/..."` in GCS, `polls_draft`, `article_revisions`) and only get promoted atomically when the entire stack succeeds. Half-finished v2 stacks never become user-visible.

**No auto-publish.** After a successful rebuild, the v2 sits as "ready to promote" with a side-by-side admin diff (old vs new article body, old vs new short MP4, old vs new poll question). Admin clicks "Promote v2" to flip the live pointers. This protects against a regen that *technically* succeeded but reads worse than the original.

## 7. Poll vs vote integrity

The hard problem: changing a poll's question after votes exist makes those votes meaningless. Three options considered, one chosen.

| Option | Approach | Why we picked / rejected |
|--------|----------|--------------------------|
| Wipe and restart | Drop old votes, new poll starts at 0 | Rejected. Destroys real engagement signal, looks bad in admin metrics, breaks the trust we promised in `_plans/2026-06-17-engagement-polls.md` §N4. |
| **Soft-archive + v2 poll** (CHOSEN) | Old poll keeps its votes, gets `enabled=0` + `archived_at`. New poll inserted with `parent_poll_id` pointing to the old. Public surfaces show only the active poll. Divisive/Agreed/Unpopular rails read from the active poll's aggregates. | Preserves vote history, makes the "this story had two versions" story explicit and queryable for future analysis, costs only one schema migration. |
| Keep question word-stable | Force the LLM to produce a poll question equal to the existing one, only refine the framing | Rejected as default. Stories where the new short genuinely uncovers a different dilemma deserve a new question — pinning the question to the old framing defeats the regen. Available as an opt-in flag for admins who want it. |

Schema delta: `polls` table gains `parent_poll_id TEXT NULL`, `archived_at TEXT NULL`. Existing rows get `parent_poll_id=NULL`. Index on `(story_id, archived_at IS NULL)` so the "active poll for this story" query stays sub-millisecond.

**No vote migration.** Votes stay attached to the poll row they were cast against. The rails (`/c/divisive`, etc.) get a one-line filter change: `WHERE archived_at IS NULL` on the polls join.

## 8. Article URL/SEO

Slug stays. Body changes. We add:

- `articles.body_revision INTEGER NOT NULL DEFAULT 1` — incremented on each regen.
- `article_revisions` table: `id, article_id, body, revised_at, source_event` so we can roll back if a v2 reads worse and the admin hasn't promoted yet (and after promotion, for archival).
- A `<link rel="canonical">` tag on the article page remains the same URL. Google reindexes the new body naturally.
- Open-graph image and title refresh to match the new short/article so re-shares pick up v2 correctly.

What we **lose**: deep links into specific paragraphs ("…in the third quote at the top") break. Acceptable cost — Lorewire articles don't currently support paragraph anchors, so no live inbound link should target that level.

What we **don't do**: no 301 redirects (slug unchanged), no sitemap re-submission (Google rediscovers on next crawl), no email notifying anyone about the rebuild.

## 9. Brand voice through the new tone knob

Replacing 5 vibes with 1 structure does not mean every short reads identically. The single structure exposes a `tone_knob` parameter selected by the script LLM per story:

- `calm-curious` — soft narration, lower emotional ceiling. For "is this a big deal or not" stories.
- `tense` — short sentences, withholding details. Replaces the old "suspense" preset's job.
- `wry` — light dry humor, second-person aside in beat 3 only. Replaces the old "conversational" preset's job for stories with an absurd edge.
- `warm-sad` — slower pacing, more sensory detail. For stories where the dilemma is grief-adjacent.

The LLM picks the tone from the source story in the same pass that drafts the script. Admin can override per-short in the editor. Default fallback: `tense` (matches the old `suspense` default).

The tone knob also feeds the voice layer's `suggested_voice_mood` (already a field on `NarrationStyle`). Concrete mapping lives in `shorts_narration.py` so the Voice stage's TTS settings change with the tone without code edits elsewhere.

## 10. Cost (real numbers, per rule 8)

Pricing pulled from `config/models.json` (verified 2026-06-21). The registry is the authoritative source; numbers below come from it.

Per-story full v2 rebuild, midpoint estimate:

| Stage | Model | Unit cost | Units | Subtotal |
|-------|-------|-----------|-------|----------|
| Article rewrite | openai/gpt-5.4-mini | ~$0.0008 / 1k out | ~2k out | $0.002 |
| Script + poll (one call) | openai/gpt-5.4-mini | ~$0.001 / call | 1 | $0.001 |
| Hero image | kie/gpt-image-2 | $0.04–0.17 | 1 | $0.10 |
| Thumbnail | kie/gpt-image-2 | $0.04–0.17 | 1 | $0.10 |
| Scene images | kie/gpt-image-2-i2i | $0.04–0.17 | ~12 | $0.72–$2.04, midpoint $1.20 |
| Voiceover | google/chirp3-hd | $0.054 / 1800 chars | ~1700 chars | $0.05 |
| Alignment | (forced alignment, local) | $0 | 1 | $0 |
| Render | Cloud Run | <$0.01 | 1 | $0.01 |
| **Per-story midpoint** | | | | **~$1.48** |

Range per story: **~$0.80 – ~$2.40** depending on image-tier selection, narration length, and retries.

Backfill cost = midpoint × N stories in production. **Production story count is not visible from the local dev DB** (zero rows locally) — admin needs to confirm count before we wire the bulk action's "go" button. The plan ships the bulk action with a hard requirement that the modal display the total estimated dollar amount before enabling the confirm button.

**Cheaper fallback**: switching scene images to `kie/nano-banana-2` (~$0.04/image flat) drops the scene-image subtotal to ~$0.48, taking per-story midpoint to **~$0.76**. Trade-off: image fidelity drops. Admin can choose per-bulk-run via a "Use cheap image model" toggle in the bulk-action modal.

## 11. Decisions locked (resolved 2026-06-21)

- **D1. Cold-open frame: new render.** Scene 1 (cold open) and scene N (return-to-climax) each get a dedicated `kie/gpt-image-2-i2i` render. Costs ~$0.10 extra per short over the reuse approach; bought for visual punch on the hook. Reuse stays on the table as a v2 A/B if production data says fresh-frame doesn't earn its cost.
- **D2. Rewind cue: spoken, 2–5 words.** Beat 2 is short spoken VO ("This started six days earlier."). Robust against audio-on viewers (~15–25% of TikTok), no glitch-perception risk. Silent transition card stays on the v2 candidate list if the spoken cue ever feels clunky in production.
- **D3. Thumbnail: frame-pick the climax scene + text overlay.** No dedicated thumbnail render in v1. Scene 1 image is reused as the thumbnail; text overlay is rendered on top in the existing renderer pass (cheap, no extra image cost). Dedicated render gets revisited in v2 only if CTR data shows the frame-pick reads weak.
- **D4. Bulk regen: manual promote per story.** Every regenerated story sits as "ready to promote" with old-vs-new admin diff. No auto-promote in v1, even on validator-clean runs. Auto-promote gets added in v2 once we have real pass-rate data to set the threshold safely.
- **D5. Hook beat #1 word budget: hard cap at 8 words.** Validator rejects anything over 8, allows one retry with tightened budget instruction, then surfaces to admin. No `climax_complexity` escape hatch. If production shows 95th-percentile retention drops on intricate stories, lift the cap to 10 in v2 — not before.

## 12. Security

- **No new external dependencies.** All new code calls existing LLM / image / TTS layers through their current adapters.
- **Article revisions** add a small data-growth surface. Bound it with a `KEEP_LAST_N_REVISIONS = 5` policy enforced on insert. Old revisions get hard-deleted (not soft) since they're internal-only and not user-facing.
- **Poll archival** preserves vote history — vote rows already store no PII (cookie token only, per `_plans/2026-06-17-engagement-polls.md` §N4), so archiving the poll row doesn't expose anything new.
- **Bulk regen** is admin-gated through the existing `/admin` auth boundary. No public surface, no API key exposure.
- **Cost-gated confirmations**: every regen path that costs money requires an explicit dollar-amount confirmation modal. No accidental $500 bulk runs.
- **Profanity/safety filter** on script output is a defense, not a primary control — the system prompt is the primary control. Filter is a backstop. Logged when it fires so we can tune the prompt rather than rely on the filter forever.

## 13. Observability

Every stage logs with a bracketed namespace, per rule 14:

- `[shorts script] generating` — story_id, model, target_seconds, tone_knob_request
- `[shorts script] validated` — story_id, hook_words, build_words, return_words, total_words, tone_knob_selected
- `[shorts script] rejected` — story_id, reason ("caps_violation", "length_overflow", "missing_field"), raw_payload_excerpt
- `[shorts poll] drafted` — story_id, question, option_a, option_b, existing_enabled_poll (bool)
- `[shorts poll] archived` — old_poll_id, new_poll_id, vote_count_at_archive
- `[shorts scene] cold_open_marked` — story_id, scene_index, visual_brief
- `[shorts regen] started` — story_id, scope ("script-only" | "full-v2"), estimated_cost_cents
- `[shorts regen] step` — story_id, step ("article" | "hero" | "scenes" | "voice" | "render"), elapsed_ms, cost_cents
- `[shorts regen] promoted` — story_id, v_from, v_to, total_cost_cents

TS side mirrors with `console.info('[shorts regen ui]', {...})` on every admin action that kicks off the pipeline.

The point of `[shorts script] rejected` carrying the payload excerpt: when the validator rejects a generation, we need to see what the model actually produced to tune the prompt. Without the excerpt we're guessing.

## 14. Settings (per rule 15)

New keys exposed in `/admin/settings` under a new "Shorts script" group:

- `shorts.script.default_tone` — overrides LLM-selected `tone_knob`. Default empty (LLM picks).
- `shorts.script.cold_open_words_cap` — hard cap on beat 1 word count. Default 8, range 4–12.
- `shorts.script.rewind_cue_mode` — `spoken` (default) or `silent`. Per O2.
- `shorts.script.cta_template` — overrideable closing-line template. Default empty (LLM writes). Power-user knob.
- `shorts.regen.default_concurrency` — bulk action default. Default 4, max 8.
- `shorts.regen.cheap_images_default` — default for the "Use cheap image model" toggle. Default off.
- `shorts.regen.auto_promote` — placeholder, default off. Wired in v2 if O4 says yes.

Existing `polls.endcard.enabled` and `polls.endcard.duration_ms` stay as-is. Burnt-in card behavior is unchanged.

Why these and not others: each is a real lever a thoughtful admin would want without forcing them to redeploy. Things deliberately NOT exposed: the structure itself (5 beats is the format, not a preference), the brand-safety guardrails (compliance, not taste), the per-stage cost cap (lives in `config/models.json` where model identity lives).

## 15. Testing (per rule 18)

New unit tests, all in `pipeline/tests/`:

- `test_shorts_narration_structure.py` — given a fixture story, generation produces all 5 beats, respects word budgets per beat, total stays ≤ 120% of target.
- `test_shorts_narration_validator.py` — `validate_script` rejects all-caps shock words, profanity list members, length overflow, missing fields; accepts a known-good payload.
- `test_shorts_narration_poll_coupling.py` — output JSON includes a `poll` block, question ≤ 80 chars, options ≤ 24 chars, neither option phrasing leaks an "answer" (heuristic: options don't contain the words "right", "wrong", "guilty", "innocent" alone).
- `test_shorts_narration_back_compat.py` — `payload["short_script"]` and `payload["payoff"]` fields still exist with their expected types; downstream code that reads them keeps working.
- `test_shorts_scene_planner_cold_open.py` — scene plan tags scene 1 with `is_climax_frame=True`, scene N with `is_climax_frame=True`, scene 1's prompt incorporates the cold-open visual brief.
- `test_regen_pipeline_atomicity.py` — simulated failure in step 5 leaves the live story untouched and shadow artifacts cleaned up.
- `test_poll_archive_on_regen.py` — regenerating a story with an enabled poll that has votes archives the old poll, votes stay attached, new poll becomes the active row, rail query returns the new poll only.
- `test_cost_estimator.py` — `estimate_regen_cost(story)` reads `config/models.json` and returns a dollar amount; precision within ±15% of actual sample runs.

Integration smoke test on the regen capability: fixture story → "Regenerate full v2" → all artifacts produced → "Promote" → live shows v2 → rerun "Regenerate full v2" → second v2 archives the first → live shows second.

The bar for "task done" is the new tests green AND the existing shorts test suite (`pipeline/tests/test_shorts*.py`) still green. Existing tests that hard-code the 5-vibe registry get updated, not deleted — they become tests of the single hook-first style with tone_knob variants.

## 16. Rollout

Two PRs on `feat/shorts-hook-first`:

1. **PR 1 — Script structure + validator + coupling.** Rewrites `shorts_narration.py`, adds `shorts_safety.py`, adds script tests, threads `cold_open_visual_brief` through the scene planner. No regen capability yet. NEW shorts generated after merge use the new structure; old shorts are untouched. Mergeable on its own.
2. **PR 2 — Regen capability.** Schema migration for `polls.parent_poll_id` / `archived_at` and `article_revisions`. Admin UI for per-story regen + bulk regen. Cost estimator. Promote flow. Tests. Depends on PR 1.

PR 1 is shippable and useful in isolation — new shorts immediately get the new structure. PR 2 is the backfill machinery and can land days or weeks later without blocking the script improvement.

## 17. What this plan does NOT do

- Does not change the renderer. `question_card.py`, scene composition, Cloud Run render path all stay as-is.
- Does not change the on-site poll UI (the `/v/[slug]` and article reader poll widgets stay; they just get better-coupled question text).
- Does not change publish/distribution. The multi-platform publisher (`_plans/2026-06-16-multi-platform-shorts-publisher.md`) reads what we render, doesn't care about our internal structure changes.
- Does not change the homepage rails or the Divisive/Agreed/Unpopular surfaces.
- Does not introduce a script-editing UI for admins. Editing the auto-generated script remains a "regenerate or live with it" choice in v1; manual-edit-with-validation is a v2 candidate if the validator proves stable.
