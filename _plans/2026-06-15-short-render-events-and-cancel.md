# Short render: live event timeline + Stop / Restart

Status: planned. Date: 2026-06-15. User picked Option A (full mirror of the
video-render pattern) with a dedicated Stop button + Restart button.

## Goal

Bring the article-shorts pipeline's observability and controls to parity with
the video-render pipeline:

1. **Live progress logs with timelapse** — a panel below the existing
   `ASSEMBLING…` progress bar that shows every phase transition as a
   timestamped line. `[02:14] character built`, `[03:47] scene 5/12 generated`.
   Auto-polls while in-flight; auto-stops on settled status.
2. **Stop button** — visible only while the row is queued or generating.
   Sets status to `cancelled`. The Python worker checks status before each
   tick and bails cleanly (no orphaned GCS objects, no half-rendered MP4).
3. **Restart button** — visible only on a settled row (done / error /
   cancelled). Re-queues the same config (this is the existing
   `enqueueShortRender(force=true)` path, just exposed under a clearer name
   than the current "Regenerate" label).

## Why this matters

The user sees `ASSEMBLING… 0%` for minutes with no signal that anything is
happening, no way to abort a bad run, and no way to re-trigger after an error
without poking the DB. The video pipeline already solved this in commit
`b098362` (2026-06-14) and the shorts pipeline never followed. Mirroring the
existing pattern means near-zero novel design risk.

## The well-trodden pattern we are mirroring

(From the Explore agent's inventory of `video_render_events`.)

- `video_render_events` schema at `lorewire-app/src/lib/schema.ts:315-326`
- `logVideoRenderEvent` at `lorewire-app/src/lib/video-render-queue.ts:436-469`
- `listVideoRenderEvents` at `lorewire-app/src/lib/video-render-queue.ts:476-486`
- `VideoRenderEventTimeline` at
  `lorewire-app/src/app/admin/(panel)/_components/VideoRenderEventTimeline.tsx`
- Force-re-render at `video-render-queue.ts:201-236`
- Image-render cancel pattern at
  `lorewire-app/src/lib/image-render-queue.ts:350-362`

Every choice below derives from those references. Nothing new is being
invented; one schema row, one component, one cancel action — all close
ports of the existing code.

## Architecture

### Data

- New table `SHORT_RENDER_EVENTS` in `lorewire-app/src/lib/schema.ts`,
  identical shape to `VIDEO_RENDER_EVENTS`:
  - `id` (TEXT, PK)
  - `render_id` (TEXT, FK shape to `short_renders.id`, no constraint)
  - `ts` (TEXT, ISO-8601)
  - `level` (TEXT, `info` | `warn` | `error`)
  - `event` (TEXT, slug like `queued`, `script_built`, `scene_generated`,
    `voice_synth_done`, `render_started`, `render_done`, `cancelled`,
    `failed`)
  - `message` (TEXT, nullable, human-readable line)
  - `payload` (TEXT, JSON, nullable — small structured detail like
    `{ scene_index: 5, scene_count: 12 }`)
- Index: `idx_short_render_events_render_id` on `(render_id, ts)`.
- The articles table is TS-owned (`short_render_events` follows). Python
  worker writes via a thin `log_short_render_event` mirror in
  `pipeline/store.py` so the worker can emit events directly (Python is
  where most events fire from).

### TS helpers (`lorewire-app/src/lib/short-render-queue.ts`)

Mirror these video-render helpers verbatim with `short_render_events`
swapped in:

- `logShortRenderEvent({ renderId, event, message?, level?, payload? })` —
  fire-and-swallow insert. Errors never bubble.
- `listShortRenderEvents(renderId, limit = 200)` — chronological, oldest
  first.
- `cancelShortRender(renderId)` — flips status to `cancelled` ONLY when the
  row is in `queued` or `generating`. Idempotent on already-cancelled and
  no-op on `rendering` / `done` / `error`. Logs a `cancelled` event.

`enqueueShortRender` already exists with a `force` option; no change needed
there beyond ensuring it writes a `queued` event (the video pattern does;
shorts currently does not).

### Worker (`pipeline/short_render_worker.py` + `pipeline/shorts_render.py`)

- After every phase transition currently logged to console with a
  `[short queue …]` prefix, emit a matching `log_short_render_event` row.
  One-to-one with the existing console lines: no new instrumentation,
  just a second sink.
- Before each tick (in the loop and at the start of each major phase
  inside `generate_short_assets`), check
  `store.fetch_short_render(render_id).status`. If `cancelled`, raise a
  sentinel exception the worker translates into a clean abort:
  - no further phase events written
  - any GCS objects already uploaded for this render stay (they are
    idempotent inputs to the next render attempt if the row is restarted)
  - `output_url` stays null
  - `finished_at` is set; `phase` is left at whatever the cancel caught
- Cloud Run render side: the actual MP4 render is one POST to
  `/render`. We do not interrupt that mid-flight (the cancellation point
  is BEFORE the render POST). If the user clicks Stop while the row is
  in `rendering`, the Stop button is hidden — that phase is too short
  to cancel cleanly. This matches the image-render cancel scope.

### Server actions (`lorewire-app/src/app/admin/videos/[id]/actions.ts`)

The video editor's actions file already holds short-related controls
(`enqueueShortRender` callers); the new actions slot in there.

- `listShortRenderEventsAction(renderId): Promise<ShortRenderEventRow[]>`
- `cancelShortRenderAction(renderId): Promise<{ ok, error? }>`
- `restartShortRenderAction(storyId, narrationStyle, lengthPreset):
  Promise<{ ok, renderId?, error? }>` — thin wrapper around
  `enqueueShortRender({ force: true })`. Same shape as the existing
  Regenerate caller; this just lives behind a button labelled "Restart"
  when the row is settled.

### UI

- `lorewire-app/src/app/admin/(panel)/_components/ShortRenderEventTimeline.tsx`
  — direct clone of `VideoRenderEventTimeline.tsx`. Polls
  `listShortRenderEventsAction` every 2 s while `isActive` (`queued` /
  `generating` / `rendering`). Renders `[HH:MM:SS] [event] message ·
  tail`. Color codes info/warn/error. Auto-opens when a render starts;
  collapses on settle.
- `ShortRenderControl.tsx` gets three additions:
  - The Timeline below the progress bar.
  - A **Stop** button next to the progress bar while in flight
    (`queued` or `generating`; hidden during `rendering` and settled).
  - A **Restart** button on settled rows. This replaces the current
    "Regenerate" label for the settled case; the active "in-flight"
    button stays as it is.

## Security (rule 13)

- All new server actions go through `requireAdmin()` (same pattern as
  every other admin action).
- `cancelShortRenderAction` validates that the render id maps to a row
  whose status is still cancel-eligible. It never deletes data; only
  flips a status. No new write surface beyond the existing queue table.
- `listShortRenderEventsAction` reads only. The events table contains
  no PII; the payload column carries phase indices and short URLs that
  are already public.
- `restartShortRenderAction` reuses the existing `enqueueShortRender`
  guards (admin gate, daily cap, idempotency-overridden via `force`).
  No new attack surface.

## Observability (rule 14)

The feature IS observability. Every event row is itself a structured
log line. In addition the actions emit namespaced console logs:

- `[short-events cancel]` — `{ renderId, status, previousStatus }`
- `[short-events restart]` — `{ storyId, oldRenderId, newRenderId }`
- `[short-events list]` — `{ renderId, count }` (server side)
- `[short-events timeline poll]` — `{ renderId, count }` (client side)

Python side (mirrors the existing `[short queue …]` console namespace):

- Every existing console line gains a sibling `log_short_render_event`
  call so the DB has the same story the console has.

## Settings (rule 15)

Walked the audit:

- Poll frequency (2 s) — not exposed. Matches the video timeline; no
  reason to vary.
- Event retention — not exposed. We can prune later if the table grows
  past a threshold; defer.
- Auto-open behavior — not exposed. Same reasoning.
- Whether Stop is visible at all — not exposed. The visibility rule
  (status-based) is the right contract.

Nothing surfaced now; nothing pre-emptively designed.

## Testing (rule 18)

TS unit tests in `lorewire-app/src/lib/short-render-queue.test.ts`
(does not exist yet — create alongside the new helpers):

- `logShortRenderEvent` — inserts one row; never throws even when the
  table is missing (mock the driver).
- `listShortRenderEvents` — returns rows in chronological order;
  respects the limit.
- `cancelShortRender` — flips `queued` -> `cancelled`; flips
  `generating` -> `cancelled`; no-op on `rendering` / `done` / `error`
  / already `cancelled`; emits a `cancelled` event row.

Python tests in `pipeline/tests/test_short_render_events.py`:

- `_log_short_render_event` — writes a row; never raises on bad input.
- Worker cancellation: stub the cancel sentinel inside one of the
  phase fns; assert the worker exits cleanly and leaves the row in
  `cancelled` status with `finished_at` populated.

Component test for the timeline mirrors the video one
(`VideoRenderEventTimeline` doesn't have a co-located test today; we
match that — the integration coverage on the polling loop comes from
the server-action tests).

## Files touched (estimate)

- `lorewire-app/src/lib/schema.ts` — add SHORT_RENDER_EVENTS + index DDL.
- `lorewire-app/src/lib/short-render-queue.ts` — three new helpers +
  `queued` event write in existing `enqueueShortRender`.
- `lorewire-app/src/lib/short-render-queue.test.ts` — new.
- `lorewire-app/src/app/admin/videos/[id]/actions.ts` — three new actions.
- `lorewire-app/src/app/admin/(panel)/_components/ShortRenderEventTimeline.tsx`
  — new (clone).
- `lorewire-app/src/app/admin/videos/[id]/ShortRenderControl.tsx` —
  mount timeline, add Stop + Restart buttons.
- `pipeline/store.py` — `_log_short_render_event` mirror, cancel-aware
  fetch helper if missing.
- `pipeline/short_render_worker.py` — emit events at every phase,
  check status before each tick.
- `pipeline/shorts_render.py` — emit events for the render-side phases.
- `pipeline/tests/test_short_render_events.py` — new.

Total: ~7 production files modified, ~3 new files. Maybe ~700 LOC.

## Out of scope

- Aborting an in-flight Cloud Run render (would require killing the
  Cloud Run job — different surface; rare in practice because the
  render phase is short).
- Retention / pruning of `short_render_events`. Defer until the table
  grows; the video equivalent has the same pending question.
- Granular per-scene Restart (restart a single scene). Restart is
  whole-row only for now.
- A live preview of the partial short. Out of scope.
