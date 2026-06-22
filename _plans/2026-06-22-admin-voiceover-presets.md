# Admin Voiceover Presets (create / save / default / per-category) + Gemini-TTS

Date: 2026-06-22
Status: Draft, awaiting approval
Owner: Yoav
Branch: feat/multi-platform-shorts-publisher (continues the shorts voice work)

## 1. Goal

Two connected things:

1. **Switch the shorts narrator to Gemini-TTS** so the voice can be *steered* by a
   natural-language style prompt into a lively young-creator delivery (Chirp 3 HD
   has a fixed character, which is why Autonoe read as a flat narrator).
2. **Let admins manage voiceovers from the admin UI**: create and save named
   voiceover presets, pick a global default, and assign a voiceover per category.

This supersedes the hardcoded `SHORTS_VOICE_*` constants approach (committed in
ca65f82). Those constants become the code-level *fallback* only; the live voice
is whatever the admin selects.

## 2. Constraints / decisions (locked)

- **Google TTS only** (no ElevenLabs for shorts). Per [[feedback_no_longform]] this is shorts-only.
- **Model: gemini-2.5-flash-tts (GA).** Stable, low-latency, style-controllable,
  ~same cost as Chirp 3 HD. Pro/3.1-preview available in the registry but not the
  default (Pro is tuned for long audiobooks; 3.1 is preview/no SLA).
- **A "voiceover" preset = { name, provider/model, voice, style_prompt, speaking_rate, hook_pause }.**
- **Resolution order for a short:** per-category voiceover -> global default
  voiceover -> code fallback (`shorts_narration` constants). Mirrors the existing
  `resolve_short_auto_config(category)` pattern.
- **Categories are the closed 6-enum** (Drama, Entitled, Humor, Wholesome, Dating,
  Roommate) from `src/app/admin/ui.ts`. Per-category mapping uses settings keys
  `voiceovers.category.{Cat}` (mirrors `shorts.auto.category.{Cat}`).
- **Gemini path differences from Chirp** (verified against Google docs 2026):
  - Style prompt goes in `input.prompt`; words go in `input.text`.
  - Markup tags (`[long pause]`, `[extremely fast]`, ...) go inline in `input.text`
    (NOT Chirp's `input.markup` + `[pause long]`). So markup must be provider-aware.
  - Pace: Gemini steers pace via the prompt / `[extremely fast]`, not
    `audioConfig.speakingRate` (that is a Chirp/standard field). So for Gemini the
    1.2x "snappy" intent is encoded in the style prompt, and `speaking_rate` is a
    no-op on the Gemini path.

## 3. Data model

- **New table `voiceovers`** (entity, like `video_segments`):
  `id TEXT PK, name TEXT, provider TEXT, voice_id TEXT, style_prompt TEXT,
   speaking_rate REAL, hook_pause INTEGER, created_at TEXT, updated_at TEXT`,
  unique index on `name`. Added to `store.py` SCHEMA_STATEMENTS + `schema.ts` mirror.
- **Settings keys** for selection (reuse the settings table):
  - `voiceovers.default` = voiceover id (global default for shorts).
  - `voiceovers.category.{Cat}` = voiceover id (per-category override; empty = inherit default).
- **Seed row** on first init: a "House Voice" preset = gemini-2.5-flash-tts + a
  youthful voice (e.g. Leda) + a young-creator style prompt, set as default.

## 4. Pipeline integration

- `pipeline/voiceovers.py` (new): `resolve_voiceover(category, get_setting, fetch)`
  returns the resolved preset dict, falling back to `shorts_narration` constants.
- `pipeline/voice.py`: thread `style_prompt` as a param into `_build_gemini_payload`
  (currently it only reads the global `voice.google_style_prompt` setting); stop
  stripping pause markup on the Gemini path; make the markup syntax provider-aware
  (`[long pause]` for Gemini in `input.text`).
- `pipeline/narration.py`: `render_narration` gains `style_prompt`; the pause-tag
  syntax becomes provider-aware (Chirp `[pause long]` vs Gemini `[long pause]`).
- `pipeline/shorts_render.py` + `shorts_lane_b.py`: resolve the voiceover for the
  story's category and pass provider/voice/style_prompt/rate/pause through.

## 5. Admin UI

New page `/admin/(panel)/voiceovers/page.tsx` (under the Settings sidebar group):

- **Presets list + editor:** create / edit / delete named voiceovers. Fields:
  name, model (select: the Google tiers), voice (the picker's Google voices),
  style prompt (textarea), speaking rate (slider), hook pause (toggle).
- **Global default:** a select of saved voiceovers.
- **Per-category:** a row per category with a voiceover select (or "inherit default").
- **Preview button** (per preset): synthesizes a fixed sample script with the
  current config and plays it, so the admin picks by ear. Costs ~1-2 cents/preview
  (Google TTS); flagged in the UI. Works on deploy (needs Google creds).
- Server actions in `actions.ts`: `saveVoiceoverAction`, `deleteVoiceoverAction`,
  `setDefaultVoiceoverAction`, `setCategoryVoiceoverAction`, `previewVoiceoverAction`.
  All behind `requireAdmin()`.

## 6. Security (rule 13)

- Admin-gated via the existing `requireAdmin()` boundary; no public surface.
- Style prompt is admin-authored free text fed to Gemini; it is a prompt, not code,
  and only affects TTS delivery. Cap length (e.g. 800 chars, Gemini prompt byte
  limits already enforced in `_build_gemini_payload`).
- Preview is cost-gated: a fixed short sample, one synth per click, logged.
- No secrets in the table; Google creds stay in env.

## 7. Cost (rule 8)

- gemini-2.5-flash-tts: ~$0.50/1M input text tokens + ~$10/1M audio output tokens.
  A ~40s short lands in low single-digit cents, ballpark the same as Chirp 3 HD
  ($30/1M chars). Confirm exact per-short on a real render (Gemini bills audio tokens).
- Each admin preview is one extra short synth (~1-2 cents). Bounded by clicks.

## 8. Alternatives rejected

- **Keep hardcoded constants** (no admin UI): rejected, user wants to manage
  voices + per-category without code changes.
- **Store presets as settings JSON blobs** instead of a table: workable and
  migration-free, but a named, listed, CRUD entity is cleaner as a table (matches
  `video_segments`). Per-category *selection* still uses settings keys.
- **gemini-2.5-pro-tts / 3.1-flash-preview as default**: Pro is audiobook-tuned and
  2x cost; 3.1 is preview/no SLA. Flash GA is the right default; both remain
  selectable in a preset.
- **ElevenLabs for the creator vibe**: rejected, ~10x cost and user wants Google only.

## 9. Open questions

- O1. In-UI **preview**: include in v1 (recommended, it is the whole point of
  "pick a voice you like") or defer? Adds a server action + small per-click cost.
- O2. Seed default voice name: Leda (youthful) is my pick pending an audition;
  final choice is tunable in the UI once you can hear it.
- O3. Does the per-category voiceover also apply to the (dead) long-form path, or
  shorts only? Plan assumes **shorts only** (long-form is retired).

## 10. Rollout

One PR on the current branch: schema + `voiceovers.py` resolver + Gemini path
rework + admin page + actions + sidebar + tests. Seed "House Voice" on init.
Existing per-story long-form VoicePicker is untouched.
