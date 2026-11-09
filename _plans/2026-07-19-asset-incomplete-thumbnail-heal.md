# Asset-incomplete: hero/thumbnail self-heal

Date: 2026-07-19
Branch: `fix/asset-incomplete-thumbnail-heal` (off `main`)

## Problem

Publishing a video story fails with `asset-incomplete: hero_image,thumbnail_image`
and never recovers, even through the "Complete & publish" path that is supposed
to self-heal missing assets.

Root cause (verified end to end):
- `hero_image` and `thumbnail_image` are BLOCKING publish gates
  (`src/lib/asset-completeness.ts`).
- The "Complete & publish" action (`bulkCompleteAndPublishAction`) classified a
  missing thumbnail under `MISSING_BLOCKS_HERO` and enqueued image asset
  `"hero"`.
- In the Python worker, asset `"hero"` runs `_regen_hero_from_short`, which
  writes ONLY `hero_image` + `hero_image_landscape`
  (`pipeline/media.py`). It never writes `thumbnail_image`. Only the 5-variant
  finisher, asset `"hero_thumbnail_from_short"`
  (`_regen_hero_and_thumbnail_from_short`), writes the thumbnail columns.
- So `thumbnail_image` stayed NULL forever. The `/api/auto_complete_publish`
  cron re-evaluated completeness every 2 min but only self-healed `video_url`
  and `poll`, never re-enqueued the thumbnail, burned its 12-attempt cap
  (~24 min), gave up, and filed a "did not publish" notification. The story was
  stuck permanently.

A story missing only a thumbnail (hero present) was even more clearly broken —
it paid for a pointless hero regen and still never got the thumbnail.

## Chosen approach — Minimal + cron backstop

Fix the wrong-asset bug at the click-time path AND give the cron a real
backstop so a thumbnail that drops LATER (after the click) also self-heals.

### SSOT (`src/lib/asset-completeness.ts`)
- Export `HERO_THUMBNAIL_BLOCKING_GATES = { hero_image, thumbnail_image }` — the
  blocking gates the finisher produces. Shared by the action and the cron so
  both agree on "this is a hero/thumbnail problem" and enqueue the SAME asset.

### Click-time fix (`src/app/admin/actions.ts`, `bulkCompleteAndPublishAction`)
- `needsHero` now keys off `completeness.blocking` (not `missing`), so an
  advisory-only landscape/square miss no longer triggers a paid regen on its
  own. The finisher refreshes those variants for free when it does run.
- The `needsHero` branch enqueues `"hero_thumbnail_from_short"` (5 variants,
  writes all hero + thumbnail columns) instead of `"hero"`. Its precondition —
  a done short to seed the character — is guaranteed here, because a missing
  short would have made `needsPipeline` true first.
- Removed the now-redundant local `MISSING_BLOCKS_HERO`; widened the outcome's
  `enqueued` union token from `"hero"` to `"hero_thumbnail"`.

### Cron backstop (`src/app/api/auto_complete_publish/route.ts`)
- New `maybeHealHeroThumbnail(storyId, completeness)`: when a blocking
  hero/thumbnail gate is still the holdup, ensure the finisher is (or gets)
  enqueued. Guarded to run at most ONE finisher at a time — the image queue is
  NOT idempotent, so it skips when a `hero_thumbnail_from_short` render is
  already queued/generating, when the daily image budget is spent, or when
  there is no completed short to seed from. Called on the not-ready path before
  the attempts increment.

## Cost (rule 8)
- Finisher = ~5 kie image calls (~$0.25) vs the old ~1-2 for bare hero. The
  cheap version never worked (the story never published), so prior spend on
  `"hero"` for these stories was pure waste. Both paths honor the existing
  daily image-budget gate (`canEnqueueImageRegen`). The cron's one-in-flight
  guard bounds spend to a single finisher per story at a time.

## Security
- Cron unchanged on auth (CRON_SECRET Bearer) + kill switch
  (`auto_publish.enabled`). The heal reuses the same budget gate and queue
  primitive the admin actions use. No new external surface.

## Observability (rule 14)
- Cron logs `[auto-complete-publish-cron hero_thumb_heal_enqueued | _inflight |
  _no_short | _budget]` so a stuck story shows exactly why the heal did or did
  not fire.

## Testing (rule 18)
- `tests/admin/bulk-content-actions.test.ts`: a thumbnail-only-blocked story
  through Complete & publish enqueues `hero_thumbnail_from_short` (not `hero`),
  reports `enqueued: ["hero_thumbnail"]`, and is flagged.
- `src/app/api/auto_complete_publish/route.test.ts` (new): cron enqueues the
  finisher for a thumbnail-only blocker; does NOT stack a second while one is
  in flight; skips when there's no completed short. 93 tests green across the
  affected suites.

## Deploy
- PR into `main`. No schema change, no env change, no new deps. The Python
  worker already handles `hero_thumbnail_from_short` (bulk "Hero + thumbnails"
  and the story-jobs finisher use it today), so this only changes which asset
  the TS side enqueues.

## Rejected alternative
- "Minimal only" (swap the asset, no cron backstop): fixes the click-time heal
  but a thumbnail that fails AFTER the click still dead-ends. The backstop is
  the actual "self-heal" the user asked for.
