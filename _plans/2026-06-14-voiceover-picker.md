# Voiceover picker with preview

**Status:** in-flight — Phase 1 + 2 starting 2026-06-14
**Owner:** Yoav (info@flexelent.com)
**Date:** 2026-06-14
**Trigger:** user request: "I want an option to re-generate the voicover and choose the narrator I want for the voiceover with a preview of their voice before choosing. this must be in the story page in the and also in the editor"

## Goals

- Admin can browse a library of narrator voices (ElevenLabs + Google Chirp 3 HD + Gemini Flash TTS), preview each with a short audio clip, and choose one per story.
- Admin can click "Regenerate voiceover" from the story page AND from the video editor's AUDIO tab.
- Per-story voice override; global setting stays as the default for new stories.
- Cost gate enforced (regen ranges $0.04–$0.75 depending on provider, must respect the existing `pipeline.story_jobs.daily_cap_cents` setting).

## Non-goals

- Custom voice cloning (rule 13: outside the picker's threat surface).
- Multi-voice narration within one story (dialog roles, etc.). One voice per story.
- Voice editing during playback (no real-time pitch shifting / speed control beyond what's already in the editor).

## Decided shape (locked 2026-06-14 by user answers)

- **Persistence:** Option A — per-story override columns + global default fallback.
- **Providers exposed:** all three (ElevenLabs / Google Chirp 3 HD / Gemini Flash TTS).
- **Edit reset on regen:** trim + caption edits drop the moment a new voice renders. New alignment = new ms boundaries, old timings would land mid-word.

## Constraints

- Voiceover regen ALWAYS produces new word-level alignment. `video_config.captions`, `video_config.duration_ms`, and any `clip_start_ms` / `clip_end_ms` must rebuild together. Failure to keep them in lockstep means captions paint the wrong words during playback.
- Regen also invalidates the latest video render (the MP4 in `stories.video_url`). The editor's stale-render badge needs to flip on.
- All three TTS providers gate on an API key in the env. Graceful degrade: if `ELEVENLABS_API_KEY` is unset, drop the ElevenLabs section from the picker rather than show a broken state.
- Google's Chirp 3 HD voices and Gemini-TTS share the same 28 prebuilt names but differ in expressive control. The voice library treats them as separate provider+id pairs (same name, different provider).

## Cost (rule 8 — to re-verify before merging Phase 4)

For a ~2500-character article:
- ElevenLabs Turbo v2.5: ~$0.75
- Google Chirp 3 HD: ~$0.04
- Gemini Flash TTS: ~$0.38

Preview-clip generation (one-time per voice for Google/Gemini): ~$0.001 each, lazy on first play, cached in GCS.

## Architecture phases

Each phase is independently mergeable. Worst-case revert is a single column drop + a feature-flag flip.

### Phase 1 — Schema + server-side voice resolution (no UI)

- New `stories.voice_provider TEXT` + `stories.voice_id TEXT` columns. Both nullable. NULL = use global.
- Python `pipeline/store.py` and TS `lorewire-app/src/lib/schema.ts` mirror columns.
- `pipeline/voice.py:synthesize(text, dest_audio, story_voice=None)` accepts an optional `(provider, voice_id)` tuple. Resolution chain:
  1. `story_voice` (per-story override).
  2. Admin global setting (`voice.elevenlabs_voice_id` / `voice.google_voice_name`).
  3. Provider's first voice (existing fallback).
- Worker call sites (`pipeline/media.py`, `pipeline/stages.py`) read the story row's voice columns and pass them through.
- New feature flag setting `voice.picker_enabled` (default `0`, i.e. off). Phase 3 flips it on once UI ships.
- Observability: `[voice resolve] story=<id> provider=<p> voice_id=<v> source=<override|global|fallback>`.
- Tests:
  - Resolution chain (3 cases: override / global / fallback).
  - Schema migration is idempotent (re-run safe).
  - `synthesize` honors the override when provider doesn't match the admin's current selection.

### Phase 2 — Voice library + preview cache (server-side helpers, no UI)

- `lorewire-app/src/lib/voice-library.ts:listVoices(): VoiceEntry[]` returns the full curated catalog with 24h server-side memoization.
- ElevenLabs entries: GET `/v1/voices` (the response carries `preview_url` per voice for free).
- Google Chirp 3 HD entries: hardcoded curated list of 8 voices (Aoede, Charon, Kore, Puck, Fenrir, Leda, Achernar, Vindemiatrix) — well-tested narrator-friendly names.
- Gemini Flash TTS entries: same 8 names, separate `provider: "gemini-25-flash-tts"`.
- `getOrCreateVoicePreview(provider, voice_id): { url: string }` lazy-synthesizes a short sample once with text "Hi, I'm your narrator for today's story." and caches in GCS at `voice-previews/<provider>/<voice_id>.mp3`. ElevenLabs entries skip this (preview_url already provided).
- Tests:
  - Library returns expected providers + counts when keys configured / missing.
  - 24h cache hit / miss / expiry.
  - `getOrCreateVoicePreview` short-circuits when GCS object already exists (no double-spend).
  - Graceful degrade when `ELEVENLABS_API_KEY` is missing.

### Phase 2.b — Preview MP3 bake script (shipped 2026-06-14)

**Why:** Phase 2 ships `listVoices()` with constructed GCS URLs but the objects don't exist yet — the picker's ▶ play button would 404 on every Google/Gemini voice. This script populates `voice-previews/<provider>/<voice_id>.mp3` for the curated 8-voice catalog × 3 providers = 24 objects, ~$0.06 total one-time cost.

**Shipped:**
- ✅ `pipeline/gcs.py:exists(key)` helper — anonymous HEAD against the public URL so the bake can skip already-baked objects without consuming an access token. Treats any non-200 (including 404, 403, transport errors) as "doesn't exist" so the caller falls into the safe re-upload path.
- ✅ [scripts/bake_voice_previews.py](scripts/bake_voice_previews.py) — synthesizes the preview text ("Hi, I'm your narrator for today's story.") for every (provider, voice_id) combo using the Phase 1 override args, uploads to the exact key shape `voice-library.ts:_previewUrlFor` reads. Flags: `--provider`, `--voice`, `--force`, `--dry-run`. Idempotent re-runs (skip-when-exists is the default).
- ✅ Curated `GOOGLE_CHIRP3_HD_VOICE_IDS` tuple in the script mirrors the TS-side `GOOGLE_CHIRP3_HD_VOICES` constant in voice-library.ts. The Python parity test locks count + ordering + format so a one-sided edit fails CI.
- ✅ Tests: 15 new in [pipeline/tests/test_bake_voice_previews.py](pipeline/tests/test_bake_voice_previews.py) — list parity (count, no duplicates, format, exclusion of ElevenLabs), GCS key shape (mirrors TS reader), filter logic (no filter / provider only / voice only / both), bake_one orchestration (skip when exists, force overrides skip, dry-run skips synth+upload, override args thread through, upload key shape).
- ✅ End-to-end dry-run walks all 24 work items cleanly.
- ✅ Suite: 15 bake + 36 voice + 8 gcs = 59 green.

**To run in prod:** `python scripts/bake_voice_previews.py` — first invocation bakes all 24 objects (~$0.06, ~3-5 minutes). Subsequent runs are no-ops (skip-when-exists). Cost is amortized — once baked, the picker plays them forever without TTS calls.

### Phase 3 — Shared `<VoicePicker />` + story-page surface (shipped 2026-06-14)

**Shipped:**
- `<VoicePicker />` client component at [lorewire-app/src/components/voice-picker/VoicePicker.tsx](lorewire-app/src/components/voice-picker/VoicePicker.tsx). Three provider sections, voice cards with name + accent + ▶ preview play. Single shared `<audio>` element so a second click stops the first preview cleanly.
- Auto-save on click: clicking a voice card fires `setStoryVoiceAction` immediately; pending state via `useTransition`.
- "Reset to global default" chip toggles between disabled (already on global) and active (clearing the override).
- Server action `setStoryVoiceAction` validates `(provider, voice_id)` against the LIVE library — tampered form values are rejected (rule 13).
- Repo helper `setStoryVoice` writes both columns in one UPDATE.
- Story page integration at `/admin/stories/[id]`: picker renders in the sidebar above the Media card, only when `voice.picker_enabled = 1`.
- 11 new tests in [VoicePicker.test.tsx](lorewire-app/src/components/voice-picker/VoicePicker.test.tsx).

### Phase 4 — Editor AUDIO tab + regen action wiring (shipped 2026-06-14)

**Shipped:**
- New `voice_renders` queue table in [pipeline/store.py](pipeline/store.py) — mirrors `story_jobs` shape with status / progress / error / output_url / cost_cents / advisory partial unique index keyed on `(story_id, text_hash, voice_provider, voice_id) WHERE status IN ('queued','processing')`.
- Python helpers: `enqueue_voice_render`, `claim_next_voice_render`, `finish_voice_render`, `fail_voice_render`, `get_voice_render`, `latest_voice_render_for_story`, `update_voice_render_progress`, `reap_stale_voice_renders`, `update_story_voice_render_output` (atomic three-column write to stories).
- TS schema mirror in [schema.ts](lorewire-app/src/lib/schema.ts) so `ensureSchema` picks up the new table on cold boot.
- Python worker [pipeline/voice_renders_worker.py](pipeline/voice_renders_worker.py) — claims a queued row, calls `voice.synthesize` with the per-story override args (Phase 1), uploads via `gcs.publish`, **rebuilds captions from new alignment via `video._chunk_alignment`**, updates `duration_ms`, clears `clip_start_ms` / `clip_end_ms`, clamps each `doodle_frames[i].caption_chunk_start_index` into the new captions count, writes audio_url + alignment + video_config in one atomic UPDATE. Per-render cost captured via the existing `media.running_cost_usd()` delta.
- TS-side queue helper [lib/voice-render-queue.ts](lorewire-app/src/lib/voice-render-queue.ts) with `enqueueVoiceRender` (race-aware), `latestVoiceRenderForStory`, `hasActiveVoiceRender`, and a `textHash` helper that mirrors the Python sha256 so both sides hash to the same hex.
- Server action `regenerateVoiceoverAction` in [actions.ts](lorewire-app/src/app/admin/actions.ts) — snapshots the per-story override at enqueue time so a mid-flight picker change doesn't reroute an in-flight render.
- VoicePicker wired: the regen button is now functional. Pending state surfaces as "Synthesizing voiceover..." in the footer + a disabled button. Last error from the previous voice_render row shows inline so a failed regen is visible without a console open.
- Editor AUDIO tab integration: when the picker flag is on AND voices are available, the AUDIO tab's Voiceover Section renders the live `<VoicePicker />` (with the current audio still playable underneath) instead of the read-only voiceover_url chip.
- Tests: 16 new Python in [test_voice_renders.py](pipeline/tests/test_voice_renders.py) (enqueue race semantics, claim/finish/fail, worker tick paths, real `_default_process` end-to-end rebuild with caption clamp), 2 new TS in `VoicePicker.test.tsx` covering regen button state transitions and the inline error surface.

**Live-run prerequisites for the regen to actually work:**
1. Phase 1's columns + Phase 2's library shipped (#3).
2. Phase 2.b bake script run (#4) so preview MP3s exist.
3. Phase 3's picker shipped (#5) so the admin can choose a voice.
4. **This PR (#6)** — flip `voice.picker_enabled = "1"` in Settings and run `python -m pipeline.voice_renders_worker` locally OR add the Vercel cron drain (Phase 4.b).

## Security (rule 13)

- Preview URLs must come from same-origin or `storage.googleapis.com` only — the picker's `<audio>` element refuses arbitrary hosts so a compromised setting can't smuggle in tracking pixels.
- Regen action requires `requireAdmin` + per-action budget gate.
- `voice_id` is validated against the live library before being persisted on `stories` — no smuggling a free-text value into the TTS call.

## Observability (rule 14)

Namespaces:
- `[voice resolve]` — synthesize-time resolution chain.
- `[voice library]` — list cache hit / miss / refresh.
- `[voice preview]` — preview synth / cache hit / cache miss.
- `[voice regen]` — Phase 4 admin action.

## Settings (rule 15)

- `voice.picker_enabled` (boolean, default `0`) — master switch for the picker UI.
- `voice.elevenlabs_voice_id` (existing) — global default for ElevenLabs stories.
- `voice.google_voice_name` (existing) — global default for Google/Gemini stories.

## Testing (rule 18)

Phase 1: 6 Python + 0 TS (schema is structural, mirrored type-only).
Phase 2: 0 Python + ~8 TS.
Total before any UI lands: ~14 tests, all unit-level.
