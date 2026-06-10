# Media orchestration in pipeline/run.py

Date: 2026-06-10 (updated 2026-06-11 to add Gemini-TTS)
Status: shipped
Section in handoff: 3.1 (orchestrate the media stages into one pipeline run)

## Goal

After `write_article` runs and stores the article body, generate the story's
hero + scene images and word-synced narration in the same pipeline pass, and
populate the `hero_image` / `images` / `audio_url` / `alignment` columns the CMS
already renders. One command (`python -m pipeline.run --media ...`) does the
whole thing end to end.

## Decisions (locked with the user)

1. **Image prompts via LLM.** One small `llm.chat` per story returns a JSON
   array of N prompt strings, each grounded in the rewritten article body and
   the `video.style` setting (default doodle look). Sub-cent extra LLM cost,
   prompts that track the actual story beats instead of generic templates.
2. **One narration serves both surfaces.** The 350-450 word article is ~2:20-3:00
   min at normal narration cadence, inside the user's 1:30-4 min video target.
   ElevenLabs renders it once, mp3 + word timings get written to the DB, and
   both the Read tab read-along and the future video stage read the same files.
   No separate "tightened" narration.
3. **Budget gate logs, does not block.** The pipeline reads `budget.daily_usd`
   and prints `[media budget] spent ~$X.XX of $Y.YY today` before each story.
   It does not skip media when over. The user wants visibility, not a guardrail
   that surprises a real run.
4. **Tests now, stdlib unittest.** New `pipeline/tests/` covers filename
   sanitization, budget estimate math, image-prompt JSON parsing (with
   fallback), and the existing `_chars_to_words` fold. Runs with
   `python -m unittest discover pipeline/tests`.

## Architecture

Match the existing module layout: thin orchestrator (`run.py`), one stage
function per concern in `stages.py`, one adapter per external service
(`images.py`, `voice.py`, `llm.py`), one new orchestrator-of-orchestrators
(`media.py`) that holds the per-story media flow.

### Additions

- `pipeline/stages.py`:
  - `make_image_prompts(idea, body, dry, n=4)` -> `list[str]`. LLM call that
    returns a JSON array of N prompts (1 hero + n-1 scenes), each combined
    with the `video.style` setting. Falls back to a single hero prompt built
    from the headline + style if the LLM returns malformed JSON.

- `pipeline/media.py` (new):
  - `generate_media(story_id, idea, body, dry)` -> dict. Returns the columns
    to merge into `upsert_story`: `hero_image`, `images`, `audio_url`,
    `alignment`, `cost_cents`.
  - Sanitizes `story_id` before it touches the filesystem
    (`^[a-zA-Z0-9_-]+$`).
  - Reads `budget.daily_usd`, prints the running estimate, never blocks.
  - Loops `images.generate` -> `images.download` into
    `lorewire-app/public/generated/<id>/`, named `hero.png`, `scene-1.png`, ...
  - Calls `voice.synthesize(body, .../narration.mp3)`, captures word timings.
  - Rolls up `cost_cents` from a small per-model price table (kie image cost,
    ElevenLabs per-char cost, llm tokens already tracked separately).

- `pipeline/run.py`:
  - New `--media` flag. When set, after `write_article` it calls
    `media.generate_media(...)` and folds the returned columns into the
    `upsert_story` call. Without `--media`, behavior is unchanged (text only).

- `pipeline/tests/` (new):
  - `test_media.py` -> sanitize, budget estimate math, image-prompt JSON parse
    + malformed fallback.
  - `test_voice.py` -> `_chars_to_words` on a known alignment shape.

## Storage

- Public path: `lorewire-app/public/generated/<id>/`. Next serves them under
  `/generated/<id>/...`. The DB stores public URLs (the path the browser
  hits), not filesystem paths.
- Story id used in the path is the sanitized reddit_id. Anything that fails
  the regex aborts the media step for that story with a clear log line.

## Observability (rule 14)

Every step prints a namespaced line with values, not just status:

```
[media id=1abc23x] start
[media budget] daily_usd cap = 5.00, est spend so far = 0.00
[media id=1abc23x prompts] 4 prompts (1 hero + 3 scenes)
[media id=1abc23x image 1/4] hero (kie/gpt-image-2, 3:4, 1K) -> public/generated/1abc23x/hero.png (4.2s, 1 credit)
[media id=1abc23x image 2/4] scene-1 -> ... (3.8s, 1 credit)
[media id=1abc23x voice] 1842 chars (elevenlabs/default, voice=21m00Tcm4TlvDq8ikWAM) -> public/generated/1abc23x/narration.mp3 (12.1s)
[media id=1abc23x done] hero + 3 scenes + 2:34 narration, est cost ~$0.58
```

## Security (rule 13)

- `reddit_id` is sanitized with `^[a-zA-Z0-9_-]+$` before it forms a path.
  Anything outside the regex aborts the story's media with a logged reason; we
  do not normalize-and-hope.
- No new secrets. Keys still come from env via `config.env`.
- We do not log API keys or full response bodies. We log step name, model,
  duration, and credit/token counts.
- File writes are confined to `lorewire-app/public/generated/<id>/`.

## Cost (rule 8)

Estimated per story on default models:

- Images (kie.ai gpt-image-2): ~$0.04-0.17 each * 4 = **$0.16-0.68**
- Voice (ElevenLabs Starter, ~$0.30/1k chars): ~1800 chars = **~$0.54**
- LLM (image prompts via gpt-5-nano): sub-cent

Per story: **~$0.70-1.25**. The default `budget.daily_usd` of 5 buys 4-7
stories/day on these defaults. The user gets a printed running estimate before
each story.

## Settings audit (rule 15)

Already covered by the existing admin settings:

- `budget.daily_usd` (consumed by the budget log line)
- `voice.elevenlabs_voice_id` (already read by `voice.voice_id()`)
- `video.style` (consumed by `make_image_prompts`)

Possible additions, NOT shipping in this pass:

- `media.scene_count` (default 3, total images = 1 + this). Currently a code
  default; surface in admin if the user wants tunability without a redeploy.
- `media.image_aspect_ratio` (default 3:4). Same reasoning.

Flagging both; will add only if the user asks.

## Testing (rule 18)

Stdlib `unittest`. Runs:

```
python -m unittest discover -s pipeline/tests
```

Covers:

- Filename sanitization (good ids pass, `..`, slashes, empty, unicode fail).
- Budget estimate math (cost per model is multiplied correctly; rolls up across
  N stories).
- Image-prompt JSON parse: valid JSON returns the list; malformed returns the
  fallback single-prompt list.
- `_chars_to_words` on a known alignment payload (golden output).

Image and voice adapter HTTP calls are NOT mocked or tested at the network
boundary; they were already verified end to end against the live APIs in the
previous session and the cost of a regression there is "the API changed,"
which a network test would not catch any better than the next real run.

## QA plan (rule 6)

After implementation:

1. `python -m unittest discover -s pipeline/tests` passes.
2. `python -m pipeline.run --dry-run --media` -> media stub path runs, nothing
   spent, DB updated with placeholder strings.
3. `python -m pipeline.run --fixture --media` -> one real story, real images,
   real voice. Verify:
   - `lorewire-app/public/generated/1abc23x/` contains hero.png + 3 scene PNGs
     + narration.mp3.
   - `hero_image`, `images`, `audio_url`, `alignment`, `cost_cents` populated
     in the DB row.
   - `[media id=...]` log lines printed at every step.
4. Sanity: open one of the images, scrub the mp3, check the alignment JSON.

## 2026-06-11 addendum: Gemini-TTS as a third Google tier

After 3.2 shipped we wired Vertex AI Gemini-TTS as additional `voice` registry
entries: `google/gemini-25-flash-tts` and `google/gemini-31-flash-tts`. Same
service account, same `texttospeech.googleapis.com/v1/text:synthesize` endpoint,
same STT alignment path as the existing Google tiers — three small differences
in the synth request body:

- `voice.modelName` is set to `gemini-2.5-flash-tts` (stable) or
  `gemini-3.1-flash-tts-preview` (preview, more expressive but ~2x cost).
- `voice.name` is the BARE form ("Aoede", "Charon", ...), not the
  locale-prefixed Chirp 3 HD form. `_gemini_voice_name` strips the prefix so
  the same `voice.google_voice_name` setting works across tiers — the lazy
  user picks a voice once.
- `input.prompt` carries an optional style instruction sourced from the new
  `voice.google_style_prompt` admin setting. Both fields count toward billing
  and toward Google's caps (4 KB each, 8 KB combined). Oversized inputs fail
  loud before the HTTP call.

Pricing estimates in `pipeline/media.py`: Gemini 2.5 Flash TTS ~$16/1M chars
(input + prompt), Gemini 3.1 Flash TTS Preview ~$33/1M chars. Numbers translated
from Google's token-based billing per yt-studio's calibration; flagged as
estimates until a real GCP invoice reconciles. ElevenLabs (~$300/1M chars on
Starter) remains in the picker as the premium English-only option.

## Rejected alternatives

- **Template image prompts** (no LLM). Cheaper but produces prompts that miss
  the doodle aesthetic and the specific narrative beats; the cost saved is
  sub-cent.
- **Separate tightened narration script.** Halves voice cost but produces a
  read-along where the text shown doesn't match the audio. Article is already
  in the target duration window, so this buys nothing.
- **Hard skip when over budget.** User wants visibility, not a guardrail that
  surprises a run mid-batch. Easy to add back as a `--strict-budget` flag if
  the cost ever gets out of hand.
- **GCS upload now.** Out of scope for this section; the handoff already lists
  it as a smaller follow-up (3.5). Local public dir is enough for validation.
