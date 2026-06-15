# Article Shorts (yt-studio doodle style)

Status: building. Phase 1 (generation core) done. Date: 2026-06-15.

## Goal

Add a per-article 40-60s vertical "Shorts" generator in the exact doodle style of the
user's own channel `thecyberexplainerr` (built with the separate `youtubestudio`
project, read-only at `_reference/youtubestudio/`). The existing long-form
(1:30-4:00) doodle pipeline stays untouched; shorts are a NEW parallel path.

Topic-agnostic (lorewire covers many topics, not just cyber).

## The validated recipe (proven in `_spike/shorts-fidelity/`)

This is the heart of the feature. Every part below was validated against the real
channel reference (`ref/out.mp4`) and signed off by the user.

- Script: `pipeline/shorts_narration.py` — 5 selectable narration vibes
  (storyteller, suspense, punchy, conversational, documentary). Default suspense.
- Style/look: `pipeline/shorts_image_style.py` `DOODLE_SUFFIX` — the
  doodle_explainer_2 hand-drawn look, with two fixes baked in: (a) NO baked text
  and NO speech/thought bubbles (the player's karaoke captions are the only text),
  (b) natural simple hands (the original "arms end in a line tip / no hands" rule
  looked broken on detailed characters).
- Character identity (the key unlock): generate the character ONCE as a base via
  `kie/gpt-image-2` (text-to-image), then every scene via `kie/gpt-image-2-i2i`
  (image-to-image, `input_urls=[base]`) re-posing the SAME character into a new
  place / pose / mood. gpt-image-2 i2i holds identity rock-solid across varied
  scenes; nano-banana-2 i2i DRIFTED (root cause of every consistency failure).
  Handles multiple / supporting characters too.
- "Motion" = the same person shown in many different places, poses and moods plus
  fast cuts and animated captions. NOT video animation. (The Remotion motion
  components exist but are off; the user explicitly does not want animation.)
- Captions: yellow karaoke, bottom-positioned, clean text-shadow outline ring
  (`outlineRing()` in `video/src/DoodleShort.tsx`; the old `-webkit-text-stroke`
  spiked at sharp corners).
- Length presets (`pipeline/shorts.py` `LENGTH_PRESETS`): `standard` (~45s, ~12
  scenes) and `extended` (~1 min, ~16 scenes, narration set to elaborate more).

Cost: ~$0.70 per short (gpt-image-2 i2i ~$0.05/frame x ~14, + voice + render).
Verify live kie + ElevenLabs/Google pricing before scaling. Voice: Google
Chirp3-HD (~$0.054/1800 chars) is ~10x cheaper than ElevenLabs for shorts.

## Architecture (mirror the existing long-form video pipeline)

A single short takes minutes to generate (14 image calls + render), far beyond
Vercel Pro's 300s function limit, so it must be a queued, multi-tick job.

- Data: a `short_renders` table mirroring `video_renders` (in `pipeline/store.py`
  SCHEMA_STATEMENTS + `lorewire-app/src/lib/schema.ts`). Idempotent on
  (article_id, config_hash). Status queued / rendering / done / error + progress.
- Generation: `pipeline/shorts.py generate_short_assets()` (done) returns script +
  character + scene image URLs, with an `on_progress(phase, cur, total)` callback
  so the worker persists progress between ticks.
- Render assembly: reuse `pipeline/voice.py synthesize()` + caption chunking +
  the `ShortVideoConfig` props shape the `DoodleShort` Remotion composition reads
  (`lorewire-app/src/lib/video-config.ts`). Captions bottom-positioned.
- Worker: a `short_render_worker.py` mirroring `render_worker.py` (drains the
  queue; image gen chunked per tick to stay under 300s).
- Orchestration: Vercel cron route mirroring `/api/render_video` claims a queued
  short and drives generation; the Cloud Run worker does the Remotion render;
  output MP4 to GCS.
- Trigger: an on-demand "Generate short" admin action + button (mirror
  `queueRender` / the `/admin/videos/[id]` render control), PLUS a settings layer:
  a global default (off / on) and per-article-type auto-generate, stored as dotted
  settings keys read by both Python (`store.get_setting`) and the app
  (`getSetting`). Narration vibe + length preset are picker options on the button.

## Security / safety (rule 13)

- Admin-only: generation actions behind `requireAdmin()`, same as video renders.
- Cost guardrails: per-article idempotency (config_hash) prevents double-charge;
  reuse the daily-cap check from `queueRender`; a per-tick image cap.
- No secrets in prompts; kie / TTS keys stay server-side (env only).
- Input is the article's own (already-trusted) text; no user free-text reaches the
  image prompt. Generated MP4s are public by design (they are the product).
- Auto-generate must respect the daily cap + budget so a category sweep cannot
  run away.

## Build phases

1. DONE — generation core: `shorts_narration.py`, `shorts_image_style.py`,
   `shorts.py` (`generate_short_assets`, length presets). Smoke-tested.
2. Render assembly + `short_renders` table + `short_render_worker.py` (voice +
   captions + props config + render), reusing voice/video helpers.
3. Vercel cron + Cloud Run wiring (chunked per-tick image gen within 300s).
4. Admin UI: "Generate short" button with narration + length pickers; progress UI.
5. Settings: global default + per-article-type auto-generate.

## Rejected alternatives (and why)

- nano-banana-2 i2i for variants: drifts character identity. Use gpt-image-2 i2i.
- OpenAI/Atlas GPT-Image-2 Edit: not needed; kie gpt-image-2 i2i is equivalent and
  already paid for.
- "Sibling-frame / near-static consistency": looked dead ("statue"). Varied poses
  WITH identity are achievable via gpt-image-2 i2i.
- Clean single-simple-character only: too limited; stories have multiple/complex
  characters, which gpt-image-2 i2i handles.
- Real video animation (micro-wiggle / mouth-swap): not what the user wants.
- Dense storybook with baked labels: labels fight the captions; suppress in-frame
  text/bubbles.

## Open questions

- Content unit: attach shorts to the CMS `articles` table vs the Reddit `stories`
  unit the long-form video uses. Resolve when wiring Phase 2 (the video pipeline
  keys on story_id; articles is the CMS). Likely: support the same unit the admin
  video editor uses.
- Exact Cloud Run shorts render entry (reuse the long-form render service with a
  shorts flag vs a sibling endpoint).
