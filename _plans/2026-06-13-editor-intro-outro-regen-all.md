# Video editor: inline intro/outro, regenerate-all, persisted prompts

**Date:** 2026-06-13
**Status:** Approved by Yoav (all four "recommended" options picked)
**Trigger:** Today's per-scene queue migration uncovered that the editor's
prompt textarea is always empty for existing frames (because the bulk
scenes regen never persisted `image_prompt` onto `doodle_frames`), that
there's no one-click "Regenerate all images" affordance inside the
editor, and that the Remotion preview is intentionally body-only — so an
admin previewing the video can't see what intro/outro will actually splice
on render.

## Goals

1. **Inline intro/outro in the Remotion preview.** Wrap the body
   composition in a Remotion `<Series>` with the active intro segment's
   MP4 before it and the outro segment's MP4 after. The Player's total
   duration grows accordingly. Honors the same resolver Python's render
   path uses (skip flag → pinned override → enabled flag → global
   active), including the Phase 3 aspect-match filter.
2. **Regenerate all images from the editor.** New header affordance
   next to the aspect picker — "Regenerate all images (N, ~$X.XX)" —
   that routes through the per-scene queue shipped today. The existing
   per-frame status pills light up as each scene finishes.
3. **Persist `image_prompt` on bulk regen.** When a `scene:N` row
   completes in the worker, write the kie prompt back onto
   `video_config.doodle_frames[N].image_prompt` alongside the new URL.
   After one Rebuild-all-scenes the editor's textarea shows what the
   pipeline used so the admin can edit + re-regen per frame.

## Non-goals

- Moving intro/outro pickers into the editor's panel. The story edit
  page already owns those; a Link from the editor's Intro/outro section
  is enough. Yoav declined the "in-editor picker" option.
- Backfilling prompts for already-rendered frames without a fresh
  regen. Yoav declined the LLM-only backfill option; prompts arrive
  naturally on the next Rebuild-all-scenes.
- Karaoke / motion beats / ken-burns in the preview. Still outside the
  preview's scope — the preview is for trim + caption iteration, not
  pixel-perfect rendering parity.
- Inline editing of intro/outro segment MP4s. Out of scope; segment
  library lives at /admin/segments.
- A kie cancel call when the user stops a bulk regen. Already covered
  by today's Stop button work — `cancelled` rows persist their state
  even if the worker finishes.

## Verified upstream facts (rule 1)

- **Remotion patterns** (Context7 query against /remotion-dev/remotion,
  2026-06-13):
  - `<Series>` + `<Series.Sequence durationInFrames={N}>` chains
    children in order; `useCurrentFrame()` inside each Sequence resets
    to 0 at the start of that Sequence. Confirmed: the body
    composition can stay unchanged inside its Sequence.
  - `<OffthreadVideo src={...}>` is the recommended Video component for
    sequenced clips inside a composition; supports remote URLs and a
    `muted` prop. We'll keep intro/outro audio unmuted (they're music
    beds; the body's `<Audio>` is wrapped in the body Sequence so the
    audio tracks don't collide).
- **Python resolver** lives at [pipeline/segments.py:pick_segment](pipeline/segments.py#L202-L258).
  Resolution chain: skip flag → pinned override → master enabled flag
  → global active id. Aspect-match filter applied last.
- **Segment URL column** is `video_segments.normalized_url`. Can be a
  GCS https URL or a `/generated/...` path. Both are browser-playable
  directly.
- **doodle_frames ↔ scene_urls indexing.** The bulk scenes path in
  [pipeline/media.py:_regen_scenes](pipeline/media.py#L897-L991) writes
  `stories.images = scene_urls[0..N-1]`. The fresh-run pipeline writes
  `video_config.doodle_frames` in the same order. So
  `doodle_frames[i].url ↔ scene_urls[i]` by index. Per-scene regen
  ([pipeline/media.py:_regen_one_scene](pipeline/media.py#L1107-L1164))
  preserves that ordering. We can stamp prompts by index without
  rebuilding a frame-id map.
- **No CHECK constraint on `image_renders.status`**, no schema
  migration needed. The `scene:N` slug is already wired end-to-end.

## Architecture

### A. Intro/outro inline preview

**Server-side (page.tsx):**

1. New helper in `lorewire-app/src/lib/segment-resolver.ts` that
   mirrors `pipeline/segments.py:pick_segment` — same chain, same
   aspect filter. Takes a `StoryRow`, returns
   `{intro: SegmentRow|null, outro: SegmentRow|null}`.
2. `page.tsx` calls it, passes `editorIntro` + `editorOutro` (each
   `{url, duration_ms} | null`) into EditorClient.

**Editor-side (EditorClient.tsx):**

1. New `PreviewProps` field on PreviewComposition: `intro` + `outro`
   (each `{url, durationMs} | null`).
2. The Player's `durationInFrames` is now
   `introFrames + bodyFrames + outroFrames`.

**PreviewComposition.tsx:**

```tsx
<Series>
  {intro && (
    <Series.Sequence durationInFrames={introFrames}>
      <OffthreadVideo src={intro.url} />
    </Series.Sequence>
  )}
  <Series.Sequence durationInFrames={bodyFrames}>
    <PreviewBodyComposition {...bodyProps} />
  </Series.Sequence>
  {outro && (
    <Series.Sequence durationInFrames={outroFrames}>
      <OffthreadVideo src={outro.url} />
    </Series.Sequence>
  )}
</Series>
```

PreviewBodyComposition holds the current preview code (body image
sequence, captions, title chip, channel badge, overlays, narration
audio). Time inside the body composition resets to 0 — no math change.

### B. Regenerate-all-images header button

**EditorClient header — minimal addition, follows existing aspect
picker pattern.**

A small button next to the aspect picker:

```
[ Regenerate all images (27, ~$1.35) ]
```

On click:
1. Open the existing BulkConfirmContext modal (same one per-frame
   regen uses for the spend-warning). User confirms.
2. Call `enqueueImageRegenAction({asset: "scenes"})`. The dispatch
   shipped today routes scenes → `enqueueScenesBulk` → N scene:N
   rows.
3. Show "27 scene jobs queued" toast; per-frame status pills will
   light up as the cron drains them.

No new server action — reuses the existing one. The button is a thin
wrapper around the same client logic the panel's RegenButton uses.

### C. Persist `image_prompt` on bulk regen

The hard one. We need `_regen_one_scene` to:
1. Generate the kie image (same as today).
2. Load `video_config` JSON.
3. Find `doodle_frames[i]` by index (the asset slug carries `i`).
4. Stamp `frame.url = new_url` AND `frame.image_prompt = prompt`.
5. Persist `video_config` alongside `stories.images`.

**Important:** the frame's `prev_image` snapshot — set by the editor
when an admin edits the prompt and clicks Regenerate — must NOT be
overwritten by a bulk regen. The per-scene path doesn't go through the
editor; it shouldn't trip the Revert state machine. So bulk regen sets
`url + image_prompt` only, leaving `prev_image` alone.

**Atomicity:** both writes (`stories.images` AND `stories.video_config`)
need to land. We don't have a wrapping transaction helper today, but
both writes update the same row (`stories.id = ?`) in two UPDATEs. A
failure between them leaves `stories.images[i]` pointing at the new
URL but the frame's `image_prompt` empty — same as today's behavior.
Acceptable for now; the only consequence is "textarea still empty,"
fixable by re-running the regen.

**Out-of-range guard:** if `doodle_frames.length < i+1`, log
`[image regen scenes] frame index N missing from doodle_frames, skipping prompt persist` and continue. Doesn't fail the regen — the
URL still lands in `stories.images`.

## Security (rule 13)

- Editor + header button gated by existing `requireAdmin` on the
  page render and on `enqueueImageRegenAction`.
- New `resolveSegmentForStory` reads from settings + video_segments;
  no user input. Safe to expose as a server-side helper.
- OffthreadVideo loads MP4 URLs into the browser. The segment library
  is admin-managed (no user-uploaded sources reach the preview),
  so URL injection isn't a vector — we trust the segment library the
  same way the renderer does.
- No story body text, no kie prompts logged in this change.

## Observability (rule 14)

- `[video editor segments]` — page.tsx logs which intro + outro
  resolved (or "none"), with reason ("skip-flag" | "pinned" |
  "aspect-mismatch" | "global-active" | "no-default"). Mirrors the
  Python resolver's logging.
- `[image regen scenes prompt persist]` — worker logs `index`,
  `frame_id`, `prompt_chars`, plus an `unchanged_frame` count summary
  at the end of a 27-scene batch.
- `[editor regen-all]` — client-side log on the header button click
  (asset count + estimate at click time).

## Settings (rule 15)

No new settings. Existing ones cover everything:
- `video.active_intro_id` / `video.active_outro_id` — global defaults
- `video.intro_outro_enabled` — master kill switch
- `stories.skip_intro` / `stories.skip_outro` — per-story opt-out
- `stories.intro_segment_id` / `stories.outro_segment_id` — per-story pin
- `media.scene_count` / `media.scene_count_mode` — bulk regen count
- `budget.daily_usd` — bulk regen budget gate

If the editor's Intro/outro panel surfaces the resolved-now segment
inline (not in this plan), a "Hide intro/outro from preview" toggle
might be worth adding later; deferred.

## Testing (rule 18)

### Unit (TS)

- `resolveSegmentForStory` returns null on skip-flag.
- `resolveSegmentForStory` returns the pinned row even when disabled.
- `resolveSegmentForStory` honors the master enabled flag.
- `resolveSegmentForStory` walks to global-active when no pin.
- `resolveSegmentForStory` drops a candidate whose aspect mismatches.
- New `latestBulkScenes` count flows into the regen-all button's
  estimate calculation correctly (covered by today's queue tests;
  extend with one estimate-display test).

### Unit (Python)

- `_regen_one_scene` persists `image_prompt` onto
  `doodle_frames[i]` after a successful regen (mock the kie call).
- `_regen_one_scene` does NOT touch `prev_image` when persisting the
  prompt.
- `_regen_one_scene` is a no-op on `video_config` when the doodle_frames
  array is shorter than `i+1` (logged warning, URL still lands).
- Concurrency: two scene:N regens for adjacent indices both persist
  their prompts onto the right frames (simulate sequential calls;
  assert both frames have correct prompts at the end).

### UI / preview

- PreviewComposition renders 3 sequences (intro/body/outro) when both
  segments resolve; 1 (body only) when neither resolves; 2 in mixed
  cases.
- Player durationInFrames equals intro+body+outro frame totals.
- "Regenerate all images" button hidden when no scenes exist on the
  story; disabled while a session-cap is already exceeded.

## Files touched (preview)

```
lorewire-app/src/lib/
  segment-resolver.ts                       new — TS pick_segment mirror
  segment-resolver.test.ts                  new

lorewire-app/src/app/admin/videos/[id]/
  page.tsx                                  resolve intro/outro, pass to client
  EditorClient.tsx                          pass segments into PreviewComposition;
                                            add Regenerate-all header button
  RegenerateAllButton.tsx                   new — thin client wrapper
                                            around enqueueImageRegenAction
  RegenerateAllButton.test.tsx              new

lorewire-app/src/components/video-preview/
  PreviewComposition.tsx                    wrap body in Series; add intro/outro
                                            OffthreadVideo sequences

pipeline/
  media.py                                  _regen_one_scene persists prompt
  tests/test_media_regen.py                 new tests
```

## Open questions

None. Proceed.

## Migration / rollout

- No schema migration.
- After deploy:
  - Editor preview will play intro + body + outro inline if the story
    has them resolved. Cold-cache first paint may briefly black-frame
    while OffthreadVideo loads the MP4 (Remotion's default behaviour;
    no fix needed here).
  - On the next "Regenerate all images" click, every scene's prompt
    starts persisting. Existing frames keep their empty textarea
    until they're regenerated.
