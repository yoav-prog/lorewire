# Stop button + per-scene queue rows

**Date:** 2026-06-13
**Status:** Approved by Yoav (zombie killed; ship the fix)
**Trigger:** Production "Rebuild all media" on story `envelope` left the
`scenes` queue row in a forever-loop. Vercel's 300s function cap can't
hold 27 sequential kie calls, the row got reaped every ~5 min and
re-claimed from scratch, no scene ever got persisted to
`stories.images`, the queue stayed blocked behind it for 7 hours, and
there was no way to stop it from the UI.

## What we're actually fixing

The 2026-06-13-worker-host-stop-button-observability plan shipped Phase 1
(cron drain) but deferred Phase 2 (Stop button). That deferral turned
into the production incident this plan responds to. We're shipping
Phase 2 now, plus the architectural fix the cron drain alone couldn't
solve: long-running asset regens can't fit in one Vercel function
invocation, so they have to be split into independently-claimable rows.

## Goals

1. **Stop button.** Per-row Stop on `MediaRegenPanel` for any queued or
   in-flight row, plus a "Stop all" in the panel header when any rows
   are active. Cancels via a new `cancelled` status the cron skips.
2. **Per-scene queue rows.** Clicking "Regenerate" on the "All scene
   images" card enqueues N `scene:N` rows instead of one `scenes` row.
   Each row regens one image (~30s, fits comfortably in a single cron
   tick). The existing `_regen_one_scene` already persists incrementally
   into `stories.images`, so progress survives function deaths.
3. **`cancelled` visible everywhere.** `LatestRenderLine`, the event
   timeline, the budget bar — every UI surface that today thinks rows
   are queued / generating / done / error knows about `cancelled` too.

## Non-goals

- Splitting `props`, `mouth_swap`, or `hero` into per-image rows. 5
  props × 30s = 150s fits in 270s with headroom; hero is 2 calls; the
  zombie was scenes-specific. Revisit if any of them start timing out.
- Removing the legacy `scenes` slug from the worker — keep it for
  back-compat (a stale queued row from before the migration must still
  drain cleanly). UI just stops enqueueing new `scenes` rows.
- A kie cancel API call. kie has no public cancel endpoint per their
  2026-06-13 docs; soft cancel (stop polling, mark cancelled) is the
  best we can do. If kie completes the task server-side, the result is
  discarded.
- Real-time progress streaming. Polling on the panel already covers
  this.

## Verified upstream facts (rule 1)

- `pipeline/store.py` has no CHECK constraint on `image_renders.status`,
  so introducing `cancelled` is additive — no migration required on
  either engine.
- `_regen_one_scene` (pipeline/media.py:1107) already updates
  `stories.images` after each single-scene save, so per-scene rows
  don't need new persistence logic.
- `claim_next_image_render` (pipeline/store.py:887) only claims
  `status='queued'`. `reap_stale_image_render_claims` only resets
  `status='generating'`. Both leave `cancelled` rows untouched.
- The drain loop processes up to `DRAIN_MAX_ROWS_PER_TICK` (default 3)
  per tick. 27 scene:N rows × ~30s = ~14 minutes wall time to drain
  fully when no other work competes — acceptable for "Rebuild all."

## Architecture

### Status lifecycle

```
queued ──claim──> generating ──finish──> done
                              ──fail──→ error
queued ──cancel──> cancelled
generating ──cancel──> cancelled  (next poll noop; worker still
                                    finishes its in-flight kie call
                                    because we have no cancel endpoint)
```

Cancelled is terminal. No re-queue.

### Bulk scenes enqueue

`enqueueScenesBulkAction(ownerKind, ownerId)`:
1. requireAdmin
2. Resolve story → look up `scene_count` via the same helper the panel
   uses (`assetImageCount("scenes")`).
3. Budget pre-flight: `estimate * scene_count <= cap - spent` (single
   check, not per-row, since the click is atomic).
4. Insert N rows in one INSERT ... VALUES (...), (...), (...) so the
   cron can't claim some between inserts.
5. Return `{ok: true, count: N, firstRenderId}` or `{ok: false, error,
   …}` on budget rejection.

The existing `enqueueImageRegenAction({asset: "scenes"})` becomes a
thin redirect to the new bulk action when called with `scenes`. The
RegenButton on the panel keeps working.

### Stop button surfaces

- On every `MediaRegenPanel` row whose `latest.status` is `queued` or
  `generating`: a small "Stop" link next to "Regenerate." Clicking it
  cancels the row.
- A "Stop all" button beside "Rebuild all media" in the panel header,
  shown only when `activeRows > 0`. Cancels every queued / generating
  `image_renders` row for the current owner.
- For the "All scene images" card specifically, the displayed
  `latest.status` should reflect the aggregate of `scene:N` rows for
  this owner — show the most recent transitional one and surface a
  "Stop all scenes" affordance that targets all of them at once.

### Display

`LatestRenderLine` learns a `cancelled` branch:
> `Cancelled · 7m ago`  (muted, not warn / not danger)

`RenderEventTimeline` already passes events through verbatim; the new
`cancelled` event we log from the cancel actions surfaces inline.

## Security (rule 13)

- Both cancel actions gated by `requireAdmin()`. Same gate as
  `enqueueImageRegenAction`.
- No new user input goes to kie or to disk — cancel is a pure DB flip.
- Race: between admin clicking Stop and the next cron tick claiming
  the row, both can land. Idempotent UPDATE (`WHERE id = ? AND status
  IN ('queued', 'generating')`) means whichever lands second is a noop.
- No story body / prompts logged. Render ids and asset slugs only.

## Observability (rule 14)

New log namespaces:
- `[cancel image render]` server action — render id, asset, prior status
- `[cancel all image renders]` server action — owner, count cancelled
- `[drain skip cancelled]` drain handler — render id (only if reaper /
  claim sees a cancelled row, which shouldn't happen with the existing
  WHERE clauses but is worth surfacing if it does)

New `image_render_events` event types:
- `cancelled` — written by the cancel actions for each row
- `cancelled_all` — written on the most recent active row, summarising
  the bulk cancel so the timeline shows it

## Settings (rule 15)

No new settings needed. Existing `media.scene_count_mode` /
`media.scene_count` continue to govern N. `budget.daily_usd` continues
to gate enqueue. The bulk action reuses both.

If the next pass surfaces a "max scenes in flight at once" knob, that
goes under Settings → Pipeline alongside `DRAIN_MAX_ROWS_PER_TICK`. Not
in this plan.

## Testing (rule 18)

### Unit (TS)

- `cancelImageRenderAction` flips queued → cancelled, returns
  `{ok: true, prior: "queued"}`.
- `cancelImageRenderAction` flips generating → cancelled (worker may
  still finish kie call but result is discarded).
- `cancelImageRenderAction` rejects done / error / cancelled rows with
  `{ok: false, error: "not-cancellable"}`.
- `cancelAllImageRendersAction` cancels only active rows for the given
  owner, returns count.
- `enqueueScenesBulkAction` inserts N rows on success.
- `enqueueScenesBulkAction` rejects when budget would be exceeded.

### Unit (Python)

- `claim_next_image_render` does not claim cancelled rows (regression
  test).
- `reap_stale_image_render_claims` does not touch cancelled rows.

### UI

- Stop button renders only when status ∈ {queued, generating}.
- Stop button hidden when status = cancelled / done / error.
- "Stop all" button hidden when no rows are active.
- LatestRenderLine renders "Cancelled · Xm ago" for cancelled rows.

## Files touched

```
lorewire-app/src/lib/image-render-queue.ts        cancellable status,
                                                  cancelImageRender,
                                                  cancelAllForOwner,
                                                  enqueueScenesBulk
lorewire-app/src/app/admin/actions.ts             cancelImageRenderAction,
                                                  cancelAllImageRendersAction,
                                                  enqueueScenesBulkAction
lorewire-app/src/app/admin/(panel)/_components/
  MediaRegenPanel.tsx                             cancelled in TRANSITIONAL,
                                                  StopAllButton in header
  StopButton.tsx (new)                            per-row stop
  StopAllButton.tsx (new)                         header bulk stop
  RegenButton.tsx                                 dispatch scenes → bulk;
                                                  cancelled display branch
  RebuildAllButton.tsx                            send scenes via bulk
lorewire-app/src/app/admin/(panel)/_components/
  RenderEventTimeline.tsx                         (no change — events
                                                  already render verbatim)
pipeline/store.py                                 (no changes — schema
                                                  permits cancelled today,
                                                  claim/reaper already
                                                  exclude it)
pipeline/tests/test_image_render_worker.py        regression: cancelled
                                                  rows not claimed/reaped
lorewire-app/tests/lib/image-render-queue.test.ts cancel + bulk-scenes
                                                  tests
```

## Migration of the dead `envelope` rows

Already done out-of-band: the 4 rows from the AITA story were UPDATEd
to status='cancelled' with an explanatory error message. No further
cleanup needed; the new UI surfaces will render them correctly once
the cancelled-branch ships.

## Open questions

None — design has been confirmed with Yoav. Proceed.
