# Video editor: YT-Shorts-style admin editor for each story video

Date: 2026-06-11
Status: planning
Section in handoff: TBD

## Goal

Give the small admin team a real, robust editor for each story's rendered
short video. The editor lives at `/admin/videos/[id]` (same id as the story),
shows every frame and every option in a YouTube-Studio-Shorts-feeling 3-col
UI, drives a **live Remotion preview** that re-renders to the player as edits
land, and only renders the final MP4 when the user explicitly confirms.

The editor is a **layer**, not the layer. Power users get an "Open in Remotion
Studio" iframe button as the escape hatch for everything we choose not to
build a first-class control for.

## Decisions

The architecture below is the council's chosen path (verdict from the
LLM Council session on 2026-06-11). Key picks:

1. **One schema, not two.** The editor writes `ShortVideoConfig` directly —
   the same JSON the pipeline writes today. No `video_edit_state` column.
   No reconciliation function in six months. Pipeline writes the *initial*
   config; humans edit *the same config*; renderer reads it.
2. **Per-field lock semantics** for human edits. When a human touches a
   field, `_locks[<field-path>] = true` flips. Pipeline re-runs respect the
   lock — locked fields are not overwritten. UI surfaces an unlock button per
   field with the diff between current value and what the pipeline would
   write now.
3. **Live `@remotion/player` preview with iframe fallback.** Day 1: 4-hour
   spike to confirm the Player embeds cleanly in a Next 16 client component.
   If it doesn't, fall back to an iframe of a `/preview/[id]` route that
   mounts the same composition. Either way, the player surface is replaceable
   without touching the editor's data layer.
4. **Render-on-confirm only.** Edits debounce-persist to the DB; the actual
   MP4 render only fires on an explicit "Render" click and goes through a
   render queue (DB-backed, polled by the local pipeline worker) so a small
   team's concurrent clicks don't spawn N ffmpeg processes.
5. **Scope cuts** (council's hard pivot): filters/effects, music ducking,
   multi-track audio, and freely-retimed captions are all out for v1. Caption
   text is editable with frozen timings; "regenerate alignment" stays a
   backend job for later.
6. **Trim is config, never source mutation.** Add `clip_start_ms` /
   `clip_end_ms` to `ShortVideoConfig`; `DoodleShort` honors them. The
   original audio/image assets are never rewritten — trim is reversible
   in one click.

## Requirements

- **User profile**: small team (2–5 admins), daily use, no external editors
  yet. Needs basic concurrency safety on the JSON column and a lightweight
  "X is editing this" indicator — not full multiplayer.
- **Editor must show every frame** (doodle_frames + intro/outro) and every
  option (text, image, caption text, motion beat toggles, audio levels,
  trim, metadata).
- **Live preview** must update within ~200ms of the most recent edit.
- **Final render** must be queueable, idempotent on `(story_id, config_hash)`,
  and observable per rule 14.
- **No regression** on the existing pipeline render path. If the editor is
  never opened for a story, the pipeline still writes `video_config` and
  renders exactly as today.

## Architecture

### Data model (single source of truth)

One new column on `stories`:

```sql
ALTER TABLE stories ADD COLUMN IF NOT EXISTS video_config TEXT;
```

`video_config` holds the full `ShortVideoConfig` JSON object plus two
editor-only sub-objects:

```jsonc
{
  "config_version": 2,
  "voiceover_url": "...",
  "title": "...",
  "channel_name": "lorewire",
  "duration_ms": 154000,
  "clip_start_ms": 0,                    // NEW: trim (v1)
  "clip_end_ms": 154000,                 // NEW: trim (v1)
  "doodle_frames": [...],
  "captions": [...],
  "caption_template": "...",
  "motion": { "micro_wiggle": true, ... },
  "ken_burns": true,
  "props_list": [...],
  "music": {                             // NEW: single bg track at fixed gain
    "url": "...",
    "gain_db": -12
  },
  "overlays": [],                        // NEW: reserved for v1.5
  "_locks": {                            // editor-managed
    "title": true,
    "captions[3].text": true,
    "music.url": true
  },
  "_edit_session": {                     // editor-managed concurrency
    "user_id": "...",
    "started_at": "2026-06-11T14:32:00Z",
    "heartbeat_at": "2026-06-11T14:34:12Z"
  }
}
```

The pipeline writes this object on first generation, respecting any existing
`_locks` when re-running. The editor reads and writes the same object. The
render step reads it, writes `.props/<id>.json`, and runs `npx remotion
render` exactly as today.

### Files we touch

```
lorewire-app/
  src/
    app/
      admin/
        (panel)/
          videos/
            [id]/
              page.tsx              # editor host
              EditorClient.tsx      # 3-col client component
              Timeline.tsx          # left: frame strip + trim handles
              PreviewPane.tsx       # center: <Player> or iframe
              tabs/
                TrimTab.tsx
                CaptionsTab.tsx
                AudioTab.tsx
                OverlaysTab.tsx     # stub for v1.5
                MetadataTab.tsx
              actions.ts            # server actions: save, render, lock/unlock
        ...
      api/
        video-config/
          [id]/
            route.ts                # GET / PATCH (debounced editor writes)
        renders/
          route.ts                  # POST queue, GET status
    lib/
      video-config.ts               # shared TS type for ShortVideoConfig v2
      video-config.zod.ts           # Zod schema (server-side validate on save)
      video-edit-session.ts         # lightweight presence + lock heartbeat
      video-render-queue.ts         # DB-backed queue helpers
      repo.ts                       # +getStoryConfig, +setStoryConfig

video/
  src/
    types.ts                        # extend ShortVideoConfig: trim, music, locks
    DoodleShort.tsx                 # honor clip_start_ms / clip_end_ms + music

pipeline/
  video.py                          # write video_config; respect _locks on re-run
  store.py                          # schema additive ALTER + helpers

migrations/                         # (none; pipeline/store.py owns schema)
```

### UI structure

Match `/admin/videos/[id]` to the LoreWire admin's existing visual language
(dark mono+accent, `font-mono` uppercase labels, `rounded-xl border
border-line bg-surface` cards) — **not** the yt-studio reference's purple
gradient look. The reference is for *layout and information density*; the
look is LoreWire admin's. (Rule 5: must not feel AI-generated; Rule 16: clean,
intuitive, clear.)

Three columns, full-bleed `h-[100svh] overflow-hidden`:

- **Left (300px, scrollable)** — Frame Timeline.
  - Intro thumb (locked, with override link)
  - For each `doodle_frame`: tiny image preview + caption-chunk preview +
    duration + edit/move-up/move-down/remove buttons + lock indicator if any
    sub-field is `_locked`.
  - Outro thumb (locked, with override link)
  - Top bar: total duration, scrub progress, "Open in Remotion Studio →".
- **Center (flex-1)** — Preview + Inspector.
  - Top: `@remotion/player` (or iframe fallback) at 9:16 aspect, max 80vh.
  - Bottom strip: scrub bar with trim handles (`clip_start_ms`/`clip_end_ms`
    overlaid on the duration), play/pause, frame jump buttons.
  - Click a frame in the timeline → seek + select; selected frame's editor
    floats below the player.
- **Right (340px, scrollable)** — Tabs.
  - Trim · Captions · Audio · Overlays · Metadata.
  - Each tab edits a slice of `ShortVideoConfig`. Every input shows a lock
    indicator; touching a field auto-locks it (with toast: "Locked from
    pipeline re-runs").
  - Footer: "Render to MP4" button — disabled while queued/rendering;
    shows progress; shows latest render URL when done.

Concurrency: when the editor mounts, write `_edit_session = {user_id, now}`.
Heartbeat every 30s. If another user opens the same editor and the heartbeat
is fresh (<2 min), show a yellow banner: "Yoav is editing this video. Open
read-only?" with a "Take over" button. Lightweight, not real-time
collaborative.

### Render queue (DB-backed, polled by local pipeline)

New table:

```sql
CREATE TABLE IF NOT EXISTS video_renders (
  id              TEXT PRIMARY KEY,
  story_id        TEXT NOT NULL,
  config_hash     TEXT NOT NULL,
  status          TEXT NOT NULL,        -- queued|rendering|done|error|canceled
  progress        REAL DEFAULT 0,
  error           TEXT,
  output_url      TEXT,
  requested_by    TEXT,
  requested_at    TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  UNIQUE (story_id, config_hash)        -- idempotency
);
```

- Editor POSTs to `/api/renders` with `{story_id}`. Server hashes the current
  `video_config` (sha256 of canonical JSON minus `_edit_session`), inserts
  a row, returns the existing row if `(story_id, config_hash)` already exists
  with a non-error status.
- The local Python pipeline gets a new `--render-queue` mode (or extends the
  existing `--video`) that polls `video_renders WHERE status='queued'`,
  picks one, renders it, writes status updates + final `output_url` (which
  becomes the story's new `video_url`).
- Editor polls `/api/renders?id=...` every 2s for progress.

This means "Render" never blocks the admin UI thread, never spawns a
runaway process, and is observable by every other admin in the team. Daily
cap (settings key `video.daily_renders_per_story`, default 20) prevents an
accidental render loop from chewing the machine.

## Per-field lock semantics

Whenever the editor writes a value into `ShortVideoConfig`, it also writes
`_locks[<dotted-path>] = true`. Pipeline re-runs use a `merge_with_locks()`
helper:

```python
def merge_with_locks(current: dict, new_from_pipeline: dict, locks: dict) -> dict:
    """Overlay pipeline output on user-edited config, respecting locks.
    Locked paths are kept from `current`; unlocked paths take new values."""
```

UI affordance: every input shows a 🔒 indicator when locked. Clicking the
icon shows the pipeline's current value and a "Unlock & use pipeline value"
button. This is the only way the user can "undo" a stale edit cleanly.

Settings audit (rule 15): one new setting `video.show_pipeline_diff_badge`
(default `true`) — when an unlocked field's pipeline value changes, the UI
shows a tiny "pipeline updated" badge until the user views and accepts.

## Security (rule 13)

- `/admin/videos/[id]` requires `await requireAdmin()` server-side, *not* just
  middleware. The existing `requireAdmin()` in `lorewire-app/src/lib/dal.ts`
  is the bar.
- All editor server actions (`saveConfig`, `queueRender`, `lockField`,
  `unlockField`) re-check admin and re-check the story id is valid before
  any write.
- Zod-validate `video_config` on every PATCH. Reject unknown top-level fields
  silently (so the renderer's "unknown fields are no-ops" rule is enforced at
  the boundary, too).
- The render queue's `requested_by` records the admin user id for every
  render. No anonymous renders.
- Music URLs must pass the same SSRF check the existing media pipeline uses —
  no `file://`, no internal hostnames.
- `_edit_session.user_id` must match the requester on every save. A second
  admin who "takes over" overwrites the session before saving.

## Observability (rule 14)

Namespaced logs at every step (browser console **and** server logs):

```
[video editor] mounted story=X config_version=2 frames=4 captions=38
[video editor] saved patch=trim debounced_ms=400 paths=[clip_start_ms,clip_end_ms]
[video editor] locked field=title
[video editor] unlocked field=title pipeline_value="..."
[video editor] heartbeat session=Y user=Z

[render queue] enqueue story=X hash=abc12 idempotent_hit=false
[render queue] start story=X hash=abc12 worker=local-1
[render queue] progress story=X frame=600/4620 percent=13
[render queue] done story=X duration_s=184 url=/generated/X/video.mp4
[render queue] error story=X message="..." retryable=true
```

Plus the existing `[video id=X ...]` namespace from `pipeline/video.py` stays
exactly as it is — the editor is additive, not a rewrite.

## Settings audit (rule 15)

Five new settings keys, grouped under "Video editor" in the admin settings
page:

- `video.editor.default_player_mode` — `embedded` | `iframe` (default
  `embedded`; flips to `iframe` if the day-1 spike fails)
- `video.editor.preview_resolution` — `full` | `half` (default `half`,
  to keep `@remotion/player` snappy on a 2:30 video)
- `video.editor.autosave_debounce_ms` — default `400`
- `video.editor.heartbeat_interval_ms` — default `30000`
- `video.daily_renders_per_story` — default `20` (hard cap; surface a warning
  at 15)
- `video.editor.show_pipeline_diff_badge` — default `true`

Per rule 15, every feature gets a Settings audit; this is it.

## Testing (rule 18)

Unit tests (Vitest in lorewire-app, unittest in pipeline):

- `video-config.zod.ts`: every required field validates; unknown top-level
  keys are stripped, not errored; `_locks` map shape; trim invariants
  (`clip_start_ms < clip_end_ms`, both within `duration_ms`).
- `merge_with_locks()`: locked path is preserved; unlocked path takes the
  new value; nested array paths (`captions[3].text`) work; missing paths in
  locks are treated as unlocked.
- `video-render-queue` helpers: idempotency on `(story_id, config_hash)`;
  status transitions queued→rendering→done; cap enforcement.
- `DoodleShort.tsx`: honors `clip_start_ms` / `clip_end_ms` (frames before
  `clip_start_ms` and after `clip_end_ms` render nothing); honors `music`
  url + gain.

Integration:

- `pipeline/tests/test_video_config.py`: full pipeline run produces a
  parseable `ShortVideoConfig v2`; re-run with `_locks` on `title` does
  not change the title.
- A Playwright smoke test (deferred to v1.5 if Playwright isn't already in
  the repo) of: open editor → edit caption text → see preview update →
  click render → poll until done → verify new MP4.

QA plan (rule 6):

1. Open `/admin/videos/<existing-story-id>` cold (no `video_config` yet) —
   server derives a default config from current pipeline outputs.
2. Edit title → preview updates within 1s, `_locks.title = true`.
3. Drag trim handle to `[3s, 28s]` → preview shows trimmed playback.
4. Edit caption text on chunk 3 → text changes in preview, karaoke timing
   still tracks original word window.
5. Click "Render" → queue row appears, progress updates, MP4 path swaps in.
6. Run the pipeline against the same story → confirm `title` is preserved
   (locked) and `images` were re-derived (unlocked).
7. Open editor in a second browser tab → see the "X is editing" banner.
8. Hit the daily render cap → confirm the warning shows at 15, the hard
   block at 20.

## Cost (rule 8)

- Remotion renders are **local** (per `_plans/2026-06-10-video-stage.md`).
  No per-render dollar cost. Compute time only: ~real-time on a modern
  laptop for a 2:30 video.
- `@remotion/player` adds ~1MB to the editor route bundle. Loaded only on
  `/admin/videos/[id]` via `next/dynamic` with `ssr: false`. No impact on
  the public site bundle.
- No new third-party services. Music tracks go through the existing
  GCS bucket; no separate library subscription proposed for v1.

## Sequencing (3-week budget)

**Week 1 — foundation**

- Day 1: 4-hour `@remotion/player` embed spike in a throwaway
  `/admin/videos-spike/[id]` route. If it embeds cleanly, continue;
  else commit to the iframe-to-`/preview/[id]` fallback and move on.
- Day 1–2: `video_config` column + Zod schema in `lorewire-app/src/lib/`
  and matching TS types in `video/src/types.ts`. Both consume the *same*
  source-of-truth file (place it in `video/src/types.ts` and re-export from
  lorewire-app).
- Day 2–3: `pipeline/video.py` writes `video_config` (DB column) in
  addition to the existing `.props/<id>.json`. Backfill helper for
  existing stories.
- Day 3–4: `merge_with_locks()` + tests.
- Day 5: `/admin/videos/[id]` skeleton (3-col layout, read-only player
  showing the current config). No editing yet. Auth + observability wired
  from day one.

**Week 2 — editing surface**

- Day 6–7: Trim tab + frame timeline with `clip_start_ms`/`clip_end_ms`.
  Day 6 in TS, day 7 honoring the props in `DoodleShort.tsx`.
- Day 8: Captions tab (text edits, frozen timings, lock indicators).
- Day 9: Audio tab (voiceover url, music url + fixed gain).
- Day 10: Metadata tab (title, description, tags, intro/outro override
  consolidated here so it lives next to the rest).

**Week 3 — render queue + polish**

- Day 11–12: `video_renders` table, queue helpers, polling worker hook in
  `pipeline/video.py`.
- Day 13: Render button + progress polling + final swap of `video_url`.
- Day 14: Concurrency banner + heartbeat + "take over" flow.
- Day 15: Settings page entries, observability sweep, QA pass per rule 6.

Anything not landed by end of week 3: defer. Overlays tab ships as a stub
("coming soon") if the timeline runs out — that's fine.

## Rejected alternatives

- **Two-schema model (`video_edit_state` separate column).** All five peer
  reviewers flagged this as the load-bearing mistake — guaranteed merge
  function nobody understands in six months. Cut.
- **Cloud render (Lambda / Vercel Function).** Adds cost + infra for no
  win at our 5–10 stories/day cadence. Local renders fit. Revisit if we
  hit team-of-10 scale.
- **Full caption timing editor.** Out for v1. Adding/deleting/merging
  caption chunks while keeping karaoke in sync is a 2-week project alone.
  V1.5 if requested.
- **Real audio ducking / sidechain compression.** Out. Single bg track at
  fixed `-12dB` is the entire audio model.
- **Filters / effects (LUTs, grain, color grading).** Out. Each is a
  Remotion shader contract change with no business case yet.
- **Live multi-user collaboration on the same video.** Out. Heartbeat-based
  "X is editing" + take-over is the bar for v1. Real CRDT collaboration is
  a separate product.

## Open questions

1. **Where do music tracks come from?** If the team uploads MP3s, we need a
   tiny "music library" admin route. If they paste URLs, the SSRF check
   above is enough. Default plan: paste URLs for v1, library UI for v1.5.
2. **Should "Open in Remotion Studio" point to a hosted Studio instance, or
   require the user to run `npx remotion studio` locally?** Local is simpler
   and matches the current render model. Confirm before week 3.
3. **Backfill strategy for existing stories without `video_config`.** Plan
   says: derive on first editor open. Alternative: backfill all in a one-time
   script. Confirm preference.
4. **Are translations / multi-language karaoke in the 3-month roadmap?** If
   yes, the schema should keep captions as a first-class array of
   `{lang, chunks[]}` from day one. If no, single-language `captions[]` is
   fine for v1. Default: single-language; revisit when needed.
