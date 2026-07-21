# Content admin cleanup: granular categories, filter panel, restart short, full pipeline & publish

**Date:** 2026-07-02
**Status:** Executing (direct instruction from Yoav, autonomous session).
**Surfaces:** /admin/content (page.tsx + ContentList.tsx), admin/actions.ts, lib/story-jobs.ts, lib/categories/repo.ts, /api/auto_complete_publish.

## What Yoav asked for

1. The Category filter on /admin/content still shows the retired six (Drama/Entitled/Humor/Wholesome/Dating/Roommate). Update it to the current category set.
2. Verify "REGENERATE ALL PUBLISHED SHORTS" runs the latest short flow (hook first -> intro -> story -> outro).
3. Audit the bulk options and add a simple "Restart" that rebuilds the whole short video including hero and thumbnails.
4. The filter rows at the top are visually overwhelming; collapse them under a "Filters" control.
5. (Follow-up message) Add a bulk option that runs the FULL pipeline for selected stories - article, short, hero, thumbnails - through to full publish, including anything he forgot to mention.

## Verified state of the code (all confirmed by reading, not assumed)

- Categories moved to the DB in the 2026-07-01 taxonomy arc. `categories` table holds 18 active granular rows (granular.ts seed) and the legacy six at status='legacy'. The pipeline classifier writes the primary tag's LABEL into `stories.category` (story_jobs_worker.py:324-348) and `syncStoryPrimaryCategoryImpl` (db.ts) re-syncs `stories.category` from `story_tags` on every boot.
- The admin content page, its filter guard, the row category chip, the bulk Category picker, and the `STORY_CATEGORIES` validation set in actions.ts all still read the legacy-six manifest (`CATEGORIES` in admin/ui.ts). They are stale.
- BUG found while mapping: the admin "set category" path writes only `stories.category` (setStoryCategory). The boot sync then reverts it to the story_tags primary label. Any admin category change silently un-does itself on the next deploy/boot.
- "Regenerate ALL published shorts" -> bulkRegenerateContentAction target 'short' -> enqueueShortRender(force:true) -> props cleared -> generation drain re-runs the LLM against the CURRENT shorts_narration prompt (five beats: COLD OPEN -> REWIND -> BUILD -> RETURN -> CTA, locked by test_shorts_narration_structure.py) and the render splices [body_hook][intro][body_rest][outro] (shorts_render.py:50-76). That IS the hook-first flow. Verified current; only the button copy needs to say so.
- "Refresh assets" (bulk bar) is already the "restart the whole short incl. hero+thumbnails" chain: voice -> enqueueShortRender(force) -> NULL 5 hero/thumb columns -> finisher regenerates hero + 5 thumbnails (api/refresh_assets/route.ts). It is badly named and easy to miss.
- Python `store.enqueue_short_render` (the path the story-jobs worker uses at the end of a pipeline run) does NOT reset a DONE short row - only error/cancelled. So a plain pipeline re-run on a story that already has a short keeps the OLD short. Any "full re-run" action must clear the done short rows first (TS side) so the worker's force-enqueue actually regenerates.
- The hero/thumbnail finisher resumes (skips i2i) when the 5 columns are already set (media.py:1742-1757). A full re-run must NULL them, same as the refresh_assets cron does.
- `bulkEnqueueStoryJobs` refuses sources at status 'used' (ALLOWED_SOURCE_STATUSES). Published stories have used sources, so the full-pipeline re-run needs an explicit allowUsed opt.
- The auto_complete_publish cron (auto_publish_when_ready flag) publishes the site AND all 6 social surfaces with per-platform dedup, but only for status != 'published', and its completeness gate has no idea a pipeline job is mid-flight - it would publish stale assets in the window after the worker flips status to 'review'. Needs a "pipeline running -> skip without burning an attempt" guard.
- The full_pipeline job lane publishes the SITE only (auto-publish.ts); arming it AND the flag would let the site publish first and then the flag cron would never fire the socials (its query excludes published). So the new action arms ONLY auto_publish_when_ready and forces full_pipeline=0 on the job.

## Changes

### A. Categories -> DB-driven (task 1 + the revert bug)
- `lib/categories/repo.ts`: add `setPrimaryStoryTag(storyId, slug, source)` - demote existing primaries, upsert the new primary row. Keeps secondary tags.
- `admin/actions.ts`: category validation reads labels from the `categories` table (all statuses, so Undo of a legacy value still works); the category write branch also resolves label -> slug and calls setPrimaryStoryTag so the boot sync can no longer revert admin changes.
- `content/page.tsx`: fetch active categories via listCategories(); filter chips render from them; the URL guard accepts any label present in the table (active or legacy) so old links keep filtering.
- `ContentList.tsx`: takes a `categories` prop ({label, color}); row chip + bulk picker + row menu use it; chip tint comes from the category's hex via inline style (runtime categories can't have static Tailwind classes - the taxonomy plan's stated pattern).
- Out of scope (flagged, not built): voiceovers/settings/templates admin pages still key per-category settings off the legacy manifest; migrating those settings keys is its own arc.

### B. Regenerate-all-shorts copy (task 2)
Verified current (see above). Update the strip + regen-target copy to name the structure ("hook first -> intro -> story -> outro") so the button says what it does.

### C. Bulk bar audit + Restart (task 3)
- Move "Refresh assets" INTO the Regenerate menu as "Restart short + hero + thumbnails" (same action, clear name). Standalone bar button removed.
- Regenerate menu labels updated: "Scene images (article illustrations)", "Short video (hook-first script + scenes + voice)", "Restart entire pipeline (article + all media)".
- Everything else in the bar verified still wired to live endpoints.

### D. Collapsible filters (task 4)
- New `FilterPanel.tsx` client island: collapsed by default; header shows a "Filters" toggle with an active-count badge, the active filters as removable summary chips (server-computed clear links), and a "Clear all" link. Expanding reveals the existing server-rendered chip rows unchanged. State survives chip-click navigations (island stays mounted).

### E. Full pipeline & publish (task 5)
- `lib/story-jobs.ts`: `bulkEnqueueStoryJobs` gains `allowUsed` (adds 'used' to the allowed source statuses) and `fullPipeline` (overrides the source row's flag on the inserted job).
- `admin/actions.ts`: new `bulkFullPipelineAction(items)`. Per story: require story kind + reddit_id; enqueue the story job (with_media, allowUsed, fullPipeline:false); on success cancel+strip the story's settled short rows (status done/error/cancelled -> cancelled, props NULL) so the worker's end-of-job force-enqueue regenerates instead of coalescing; NULL the 5 hero/thumb columns so the finisher does fresh i2i; flag auto_publish_when_ready.
- `/api/auto_complete_publish`: flagged story with an active story job (queued/processing) is skipped WITHOUT bumping attempts, logged as `pipeline_running`. Closes the stale-asset publish race and stops the 12-attempt budget burning while the pipeline runs.
- ContentList: new "Full pipeline" bar button + confirm modal (cost ~= $1.50/story worst case; the story leaves the public site during the rebuild and republishes automatically; platforms already posted are skipped by the publishers' dedup) + result banner.

## Sequencing / lifecycle of the new action
enqueue job -> worker rewrites article+voice (status -> review; story off-site) -> worker force-enqueues short (old rows were cancelled, so full regeneration with the NEW body) -> finisher regenerates hero + 5 thumbnails (columns were NULLed) -> auto_complete_publish cron sees flag + complete assets -> publishes site + all socials (dedup skips already-posted platforms).

## Security
No new public surface. New action begins with requireCapability("content.manage"); items go through validateItems (cap 200). allowUsed only widens which reddit_source statuses an ADMIN action may re-enqueue; the cron guard only reads. Kill switches unchanged (auto_publish.enabled still gates the publish cron).

## Cost
No new paid service. The action re-spends existing per-story pipeline cost (~$0.50 LLM/TTS/images + ~$1.13 short + ~5 finisher i2i calls -> quoted "~$1.50 per story worst case" in the modal). Cost is surfaced before commit, matching the other bulk modals.

## Observability
- `[content bulk full-pipeline] start/enqueued/failed/done` with per-story ids + reasons.
- `[auto-complete-publish-cron step]` gains result 'pipeline_running'.
- `[content filters] toggle/clear` on the new panel.
- Category writes log prev/next label + slug.

## Settings audit
No new settings. The action deliberately reuses auto_publish.enabled / auto_publish.max_attempts (existing knobs). The filter panel's open state is session-local by design (active filters stay visible when collapsed, so persistence adds nothing).

## Testing
- categories/repo.test.ts: setPrimaryStoryTag (fresh primary, switch, preserve secondaries).
- bulk-content-actions.test.ts: granular label accepted + story_tags primary written; junk label rejected; legacy label still accepted (undo path).
- New tests for bulkFullPipelineAction: happy path (job row + flag + thumbs NULLed + done short cancelled), article rejected, no-reddit-source, active-job skip.
- story-jobs: allowUsed accepts a used source; default still refuses.
- Suite: `npm test` in lorewire-app (vitest, per-process SQLite).

## Deploy
Branch: current work happens on a fresh branch off main per the standing git rules; no push/merge without explicit approval. Production tracks main via Vercel; nothing here touches vercel.json or env.
