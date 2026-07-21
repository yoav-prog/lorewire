# Restart pipeline self-heal (Option A)

Date: 2026-07-19
Branch: `feat/restart-pipeline-self-heal` (off `main`)

## Problem

Operators repeatedly hit two dead ends when trying to (re)publish from
`/admin/content`:

1. **"reddit source is used or skipped — pipeline cannot re-run"** on the
   *Restart entire pipeline (article + media)* bulk action. Root cause: that
   action calls `bulkEnqueueStoryJobs` WITHOUT `allowUsed`, so any story that
   already shipped (its `reddit_source` row sits at status `used`) is refused.
   A near-identical second button, *Full pipeline & publish*, DOES pass
   `allowUsed: true`. Two look-alike buttons with an invisible difference is a
   trap, and the error message conflates `used` (fixable, use the other button)
   with `skipped` (the operator's own "no") into one opaque line.

2. Separately, *asset-incomplete: hero_image,thumbnail_image* on publish — a
   different gate (missing hero/thumbnail), tracked as a follow-up below, not
   part of this change.

Owner expectation (Yoav): "If I ask to restart a pipeline, nothing should stop
me." The safety gate is not wrong in spirit (a re-run costs ~$0.50 and pulls a
live story off the site while it rewrites), but the UX around it is hostile.

## Chosen approach — Option A

Make *Restart entire pipeline* just work, with the one real safety fact kept
visible, and give `skipped` its own honest message plus a one-click override.

### Backend (`src/app/admin/actions.ts`)
- `bulkRegenerateContentAction`, `pipeline` target: pass `allowUsed: true` so
  already-shipped (`used`) sources re-run. After this, `skipped_status` from
  the enqueue uniquely means the source is `skipped` (operator's "no") — map it
  to a new, precise reason `reddit-source-skipped` instead of the conflated
  `reddit-source-locked`.
- New action `bulkRestartPipelineForceAction(items)` — the "Re-run anyway"
  override for `skipped` sources: flips a `skipped` source back to `imported`
  (leaving `used` as-is; `allowUsed` handles those), then enqueues. Same paid
  cap + audit as the other bulk paid actions. Heals a stuck `processing`
  source (no active job) the same way.

### Client (`.../content/ContentList.tsx`)
- `REGEN_TARGET_META.pipeline` body: rewrite the now-false "only unused sources
  can be re-run" copy; state plainly that shipped stories re-run and drop off
  the site briefly, and that skipped sources need "Re-run anyway".
- `RegenConfirmModal`: for the `pipeline` target, show how many selected
  stories are currently live (status `published`) so the operator sees the
  offline cost before committing.
- `describeReason`: add `reddit-source-skipped` -> honest copy.
- `RegenResultBanner`: for `pipeline` failures with reason
  `reddit-source-skipped`, render a "Re-run anyway" button that calls
  `bulkRestartPipelineForceAction` on exactly those rows.

### Alternatives rejected
- **Option B** (keep both buttons, only fix the message): still leaves the
  twin-button trap.
- **Option C** (no gate at all, no confirm): loses the guard against a bulk
  select silently spending money and pulling many live stories offline at once.

## Security
- New action reuses `requireCapability("content.manage")`, `validateItems`
  (paid cap `MAX_BULK_PAID_ITEMS`), and `auditBulkContent` — same authz + rate
  bound + audit trail as every other bulk paid action. No new surface.
- `setRedditSourceStatus` only ever moves a `skipped`/`processing` row to
  `imported`; it never nulls a `used` row's `story_id`, so a live story's link
  is preserved.

## Observability
- New action logs `[content restart-force] start/done` with counts.
- Client logs `[content list restart-force request/result]`.

## Testing (`tests/admin/bulk-content-actions.test.ts`, `src/lib/story-jobs.test.ts`)
- story-jobs: `allowUsed: true` accepts a `used` source; `skipped` still blocked.
- pipeline target now enqueues a `used` source (was: refused).
- pipeline target maps a `skipped` source to `reddit-source-skipped`.
- `bulkRestartPipelineForceAction` flips `skipped` -> enqueued; skips articles /
  no-reddit; skips an already-running pipeline.

## Deploy
- PR into `main`. No schema change, no env change, no new deps. Deploy-inert
  until merged; the new button appears in the existing content admin surface.

## Follow-up (separate change)
- Investigate *asset-incomplete: hero_image,thumbnail_image* — the hero +
  thumbnail finisher not completing, blocking publish. Different code path
  (`MISSING_BLOCKS_HERO` / the finisher), tracked next.
