# Short editor: full parity with the long-form video editor

Status: planned. Date: 2026-06-16. User picked Option A from the
2026-06-15 events/cancel discussion: "build the short editor; mirror the
long-form video editor structure."

This plan is the blueprint. It is intentionally larger than usual because
the scope is larger than usual — implementation will land across 4-5 PRs.
The phases below are independently shippable.

## Goal

Today the short generation surface is a dropdown for vibe + length, a
Generate button, and (after the 2026-06-15 events PR) a Stop / Restart +
log timeline. The user cannot touch the result. Their stated bar:
"the short should be FULLY EDITABLE."

Definition of "fully editable" for shorts, derived from the long-form
video editor's existing affordances at
`lorewire-app/src/app/admin/videos/[id]/`:

1. **Per-scene image control** — see every scene as a thumbnail, edit
   its prompt + alt + caption, regenerate one scene without re-running
   the whole short, swap one scene's image for an upload or a frame from
   somewhere else.
2. **Caption editing** — edit each caption chunk's text, change timing
   (start_ms / end_ms), pick from caption presets the way the long-form
   editor does today.
3. **Voice editing** — per-short voice override (provider + voice_id) +
   "Regenerate voiceover" without re-running scene generation.
4. **Narration script editing** — direct edit of the script text the
   shorts pipeline produced, with "re-narrate from edited script" that
   keeps existing scenes but resynthesizes audio.
5. **Partial re-render** — only re-run what actually changed. Edit one
   scene → only that scene + the final assembly re-run. Edit one
   caption → only the final assembly re-runs. Edit the voice → audio +
   final assembly. Today every edit forces a full $0.70 regeneration;
   partial re-renders are how the cost story stays sane.
6. **Session edit concurrency banner** — mirror what the video editor
   has so two admins can't stomp each other.
7. **Stop / Restart** — already shipped 2026-06-15.

## Out of scope (deliberate, with rationale)

- **Aspect toggle** — shorts are always 9:16 by definition. No switch.
- **Intro / outro splices** — shorts traditionally don't carry them; the
  yt-studio reference channel doesn't. Adding the affordance is dead
  weight until the user asks.
- **Music tracks** — long-form has a music URL + gain control. The
  shorts recipe doesn't use music (the voiceover is the only audio).
  Skipping until the user asks.
- **Force re-render of EVERYTHING** — already covered by the existing
  Restart button (force=true). The new partial re-render is additive.

## The pattern we are mirroring

The long-form video editor at
`lorewire-app/src/app/admin/videos/[id]/EditorClient.tsx` is the model.
It is a client component that mounts:

- A **tab bar** (Frames / Captions / Voice / Music / Render).
- A **shared video config** (\`ShortVideoConfig\` JSON, validated by
  \`parseVideoConfig\`, persisted to \`stories.video_config\`) edited via
  one generic action: \`saveVideoConfigPatch\`. The patch carries the
  dotted paths the user touched + \`_locks\` for collaborative editing.
- A **frames panel** that lists doodle_frames with per-frame regen
  buttons (the \`GranularRegenGrid\` pattern from
  \`/admin/(panel)/_components/GranularRegenGrid.tsx\`).
- A **captions panel** with per-chunk timing + text editing
  (\`Captions.tsx\` in EditorClient.tsx; reads captions[] from config).
- A **voice picker** (\`VoicePicker\` from \`@/components/voice-picker\`).
- A **render queue + render control** that watches \`video_renders\` and
  shows the in-flight phase.
- An **edit-session banner** (\`claimEditSession\` /
  \`heartbeatEditSession\` server actions) that warns when a second
  admin is editing the same story.

Every piece above already exists for video; the short editor copies the
file shape with shorts-specific data sources. Almost nothing new.

## Architecture

### Data: where does the "edited short" live?

The current short generation writes its output to
\`short_renders.props\` as a serialized DoodleShort composition. That
column was always meant to be the renderable artifact, not the editable
source.

The cleanest answer mirrors the long-form video editor:

- New column \`stories.short_config\` (JSON), nullable, mirrors the
  existing \`stories.video_config\`. Format: a \`ShortConfig\` v1 schema
  with these load-bearing fields:
  - \`config_version: 1\`
  - \`source_render_id\`: the \`short_renders.id\` the config was seeded
    from (so we know which render produced this baseline).
  - \`narration_style\`, \`length_preset\`: provenance.
  - \`script: string\` — editable script text.
  - \`doodle_frames: Array<{ id, url, alt, prompt, caption_chunk_start_index, is_pinned, source }>\`
    Each frame carries the prompt that produced its image (so per-scene
    regen has the right input) plus \`is_pinned\` (set true when the
    admin manually swaps the image so a full regenerate doesn't replace
    it).
  - \`captions: Array<{ start_ms, end_ms, text }>\`
  - \`voice: { provider, voice_id } | null\` — override; null = global
    default.
  - \`duration_ms: number\`
  - \`_locks: Record<string, string>\` — per-path lock map identical to
    video config.
  - \`_edit_session: { user_id, started_at, heartbeat_at } | null\` —
    identical concurrency primitive.
- A new \`short_video_config.ts\` library that mirrors
  \`lib/video-config.ts\`: \`ShortConfig\` Zod schema, \`parseShortConfig\`,
  \`applyShortConfigPatch\`, \`defaultShortConfig(story, props)\` that
  seeds from a successful \`short_renders.props\`.

### The new editor surface

Move the existing \`ShortRenderControl\` (Generate / Restart / Stop +
timeline) out of the long-form editor and make it the FOOTER of a new
\`ShortEditor\` component at
\`lorewire-app/src/app/admin/(panel)/shorts/[storyId]/page.tsx\`. The
editor's tabs:

1. **Script** — textarea with the editable script. "Re-narrate from
   script" button enqueues a voice-only re-render.
2. **Scenes** — grid of frame thumbnails (one per
   \`doodle_frames[i]\`). Each cell shows:
   - The image (from \`url\`).
   - Inline editable prompt + alt.
   - A "Regenerate this scene" button (enqueues into image_renders
     with \`owner_kind = 'short_scene'\`).
   - A "Swap image" affordance (upload, OR pick from another short's
     frames — the same surface we built in
     \`_plans/2026-06-15-shorts-to-article-media.md\`).
3. **Captions** — list of chunks with start/end/text inline editors,
   same column layout as the video editor.
4. **Voice** — \`VoicePicker\` instance scoped to this short (override
   stored on the short_config). "Regenerate voiceover" enqueues a
   voice-only render.
5. **Render** — the existing ShortRenderControl footer, plus a primary
   "Render after edits" button that does the partial-re-render
   orchestration described below.

### Partial re-render orchestration (the hard half)

This is where shorts diverge from long-form. The video editor today does
a single thing: enqueue a full render. Shorts already have a two-stage
queue (generation drain → render drain). To make a partial re-render
work cheaply we need three render lanes the editor can pick from:

- **Lane A — Final assembly only.** No regeneration. Voice + frames
  unchanged. Captions text/timing changed → rebuild the Remotion props
  and re-run the Cloud Run /render POST. Cost: ~$0.05 (Cloud Run
  rendering time).
- **Lane B — Voice + assembly.** Script or voice changed; scenes
  unchanged. Re-synthesize the voiceover, rebuild captions from the new
  audio, re-render. Cost: ~$0.05 voice + ~$0.05 render ≈ $0.10.
- **Lane C — Per-scene + assembly.** N scenes touched. Regenerate just
  those scenes (kie i2i with the existing base character), keep the
  rest, re-render. Cost: ~$0.05 per touched scene + $0.05 render.

The editor picks the lane automatically by diffing the new
\`short_config\` against the \`source_render_id\`'s baseline. The "Render
after edits" button shows the lane it's about to take with the cost
estimate before the click (rule 8). Force-full-regen stays on the
existing Restart button.

Implementation seam: a \`short_render_plan(currentConfig, baseline)\`
helper returns \`{ lane: 'A'|'B'|'C', touched_scene_ids: string[],
estimated_cost_cents: number }\`. Tests cover every diff combination.

### Per-scene regen queue

Reuse the existing \`image_renders\` queue with a new \`owner_kind =
'short_scene'\` and \`owner_id = \`${shortRenderId}#${frameId}\`\`. The
worker (\`pipeline/image_render_worker.py\`) already handles kie i2i;
add a thin dispatcher for the short-scene case that:

1. Fetches the base character image from the source
   \`short_renders.props.character_base_url\` (already stored).
2. Runs kie gpt-image-2-i2i with the new prompt + base.
3. Writes the new URL back into
   \`stories.short_config.doodle_frames[idx].url\` AND sets
   \`is_pinned = true\` so a future full regenerate doesn't replace it.
4. Logs into \`image_render_events\` like every other image regen.

### Edit session concurrency

Verbatim port of the video editor's edit-session affordance. Same column
layout, same TTL, same banner UI. \`claimShortEditSession\` /
\`heartbeatShortEditSession\` server actions live in the new short
editor's actions file.

## Phases (each independently shippable)

1. **Phase 1 — Short editor scaffold + Scenes tab.** ~700 LOC.
   - \`stories.short_config\` column, \`ShortConfig\` schema, helpers.
   - New page at \`/admin/(panel)/shorts/[storyId]\` with the tab bar
     and only the Scenes tab populated.
   - Per-scene image regen via \`image_renders\` + owner_kind extension.
   - \`is_pinned\` flag and pin-aware full regenerate.
   - Tests for the schema, the helpers, the regen dispatcher.

2. **Phase 2 — Captions tab + partial-assembly re-render (Lane A).**
   ~500 LOC.
   - Captions list editor with per-chunk timing + text.
   - \`short_render_plan\` helper + tests for Lane A detection.
   - "Render after edits" button wired to Lane A when only captions
     changed.

3. **Phase 3 — Voice tab + partial-voice re-render (Lane B).** ~400 LOC.
   - VoicePicker instance bound to the short_config voice override.
   - "Regenerate voiceover" enqueues a voice-only render through the
     existing \`voice_renders\` queue with shorts-specific seam.
   - Script-textarea-edit path that bumps the script + triggers Lane B.

4. **Phase 4 — Lane C orchestration + cost preview.** ~400 LOC.
   - Wire \`short_render_plan\` to pick Lane C when any scene was
     touched in this edit session.
   - Render button shows the lane + cost estimate before the click.
   - Tests for the diff detection + cost math.

5. **Phase 5 — Edit-session banner + admin polish.** ~300 LOC.
   - Concurrency banner identical to the video editor.
   - Click-to-take-over UX.
   - Heartbeat actions.

Total estimate: ~2300 LOC across the five PRs.

## Security (rule 13)

- Every action: \`requireAdmin()\`.
- Per-scene regen routes through the existing \`image_renders\` queue
  which already has admin gating, owner-scope checks, and a per-owner
  daily cap. No new ingress.
- The \`stories.short_config\` column accepts JSON validated through a
  Zod schema at the action boundary. Malformed configs are rejected
  before they hit the column.
- Cost guardrails: the existing per-story / per-session daily caps
  (\`shorts.daily_renders_per_story\`, \`shorts.session_spend_limit\`)
  apply. Lanes A and B are cheap; Lane C is gated by the existing
  image-regen daily cap.
- Stage prompts are never user-supplied free text in shorts (the script
  is editable but it doesn't reach the kie image prompt; the per-scene
  prompts are the kie path and they are editable). Per-scene prompt
  text becomes user input that reaches an external API — wrap it
  through the existing prompt-safety scrub used by the video editor's
  per-frame regen path.

## Observability (rule 14)

Plan calls for namespaced \`[short editor …]\` logs on:

- Tab navigation (\`[short editor tab]\` with story_id + tab).
- Patch saves (\`[short editor patch]\` with paths + lane prediction).
- Per-scene regen click (\`[short editor scene-regen]\` with frame_id +
  prompt diff).
- Render-after-edits click (\`[short editor render]\` with lane +
  estimated cost cents + scene_ids touched).
- Session lifecycle (\`[short editor session]\` claim / heartbeat /
  takeover).
- \`short_render_events\` already carries the worker-side phase log we
  shipped in the 2026-06-15 PR.

## Settings (rule 15)

Walked the audit. New settings introduced:

- \`shorts.editor.heartbeat_interval_ms\` — mirror the video editor's
  setting. Default 5000.
- \`shorts.editor.autosave_debounce_ms\` — debounce for script /
  caption edits. Default 1500.
- \`shorts.session_spend_limit_cents\` — per-edit-session cap on Lane C
  regen spend. Default 500 (= $5 / session).
- \`shorts.editor.default_tab\` — which tab opens first. Default
  "scenes".

Each lands on the admin settings page in the existing "Shorts" group.

## Testing (rule 18)

Per phase:

- **Phase 1.** Unit tests for \`ShortConfig\` schema (positive +
  negative). Tests for \`is_pinned\` interaction with the existing
  enqueueShortRender(force=true) path: pinned frames survive a full
  regenerate. Tests for the \`image_renders\` short-scene owner-kind
  dispatcher.
- **Phase 2.** Lane-A detection tests (caption-only change → Lane A).
  Caption editor tests (per-chunk timing validation).
- **Phase 3.** Lane-B detection tests. VoicePicker integration tests
  for the short_config voice override path.
- **Phase 4.** Lane-C detection tests (single scene, multiple scenes,
  mixed with caption/voice changes — lane priority resolution). Cost
  math tests against a fake-prices fixture.
- **Phase 5.** Edit-session concurrency tests mirroring the existing
  video editor suite.

Component tests for each tab follow the
\`tests/lib/video-config.test.ts\` pattern (pure validators) + the
\`src/components/voice-picker/VoicePicker.test.tsx\` pattern (mock
server actions, assert click handlers).

## Open questions for the user

These are worth confirming BEFORE Phase 1 ships:

1. **Per-scene swap from another short.** The article-media bridge
   already supports "promote a frame to an article gallery." Should the
   Scenes tab here support the inverse — "pull a frame from another
   short into THIS short"? Cheap to add in Phase 1 since the data path
   exists; adds one button.
2. **Auto-render on edit vs. explicit Render button.** Long-form is
   explicit (the admin clicks Render). Shorts could autosave +
   auto-render Lane A on debounce because Lane A is cheap. I lean
   toward explicit-only across all three lanes for predictability and
   cost-control transparency. Confirm.
3. **Scope of "fully editable."** This plan covers script, scenes,
   captions, voice. NOT covered: per-character world bible (no concept
   in shorts yet), intros/outros (out of scope above), music tracks
   (out of scope above). Confirm those omissions before Phase 1.
4. **Phase ordering.** Phase 1 ships Scenes — that's the biggest visual
   win. Captions (Phase 2) is the second most-used edit; Voice (Phase
   3) third. If your iteration loop is voice-first, swap 2 and 3.

## What this plan deliberately does NOT do

- Reinvent any existing pattern. Every primitive used here exists for
  long-form video; the work is porting.
- Replace the existing ShortRenderControl. It becomes the footer of the
  new editor surface; the old "Generate Short" affordance in the video
  editor stays as the entry point until Phase 1 ships, then the entry
  becomes a "Open short editor" link.
- Touch the public reader surface. Shorts already render via Remotion
  + the existing video URL pointer; nothing about the reader changes.
- Add a new external service or API. Every render lane uses queues we
  already have.
