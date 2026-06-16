# Reddit imports default to shorts

**Date:** 2026-06-16
**Status:** Approved + implemented

## Goal

Make Reddit imports produce a **short** as the video for the story by default, instead of the current long-form video. Expose the choice as a setting and a per-batch override on the "Process N selected" admin action.

## Why

We just shipped Phase 1 + Phase 2 of the short editor. Reddit imports are the primary content source. Making shorts the default closes the loop: an admin who clicks "Process N" gets the format that matches the editor we just built, without having to remember to flip a setting first. Shorts are also cheaper to render than long-form (no Cloud Run remotion render), so the default is cost-friendly.

## Scope decisions (locked with the user)

1. **Output:** short only (skip long-form). Not "both", not "vertical long-form".
2. **Setting:** global default, plus per-batch override on the Process N footer. No per-subreddit override.
3. **Setting key:** `reddit.default_output` with values `short` | `long`. Default `short`.
4. **Override column:** `story_jobs.output_format` TEXT NULL. NULL = use setting at process time.

## Architecture

```
                                   short  -> skip long-form video render
                                            force-enqueue short_render
admin Process N -> story_jobs row -+
   (output_format)                 |
                                   long   -> existing path:
                                            long-form video render +
                                            optional auto-short (existing setting)
```

The output decision is made **at worker claim time**, not at enqueue time. The row only stores the override (or NULL); the worker resolves `row.output_format ?? get_setting('reddit.default_output') ?? 'short'`. This way:
- Changing the setting takes effect for already-queued NULL rows (admin intent for newly-queued rows is usually "current default").
- An explicit override on the row survives a setting change (admin's batch intent wins).

## Files touched

### Schema
- [lorewire-app/src/lib/schema.ts](lorewire-app/src/lib/schema.ts) - add `output_format TEXT` to `STORY_JOBS`.
- [pipeline/store.py](pipeline/store.py) - add `ALTER TABLE story_jobs ADD COLUMN IF NOT EXISTS output_format TEXT` to the additive migration list. Update `enqueue_story_job` to accept and write the new column. Update SELECT lists that read story_jobs rows.

### TS plumbing
- [lorewire-app/src/lib/story-jobs.ts](lorewire-app/src/lib/story-jobs.ts) - `bulkEnqueueStoryJobs(ids, { output_format?: 'short'|'long' })` writes the column. Type `StoryJobRow` gains `output_format: 'short' | 'long' | null`.
- [lorewire-app/src/app/admin/actions.ts](lorewire-app/src/app/admin/actions.ts) - `processRedditSourcesAction` reads `output_format` form field, validates as a closed enum (`'short'|'long'|''`), passes through. Empty string = NULL = "use default".

### UI
- [lorewire-app/src/app/admin/(panel)/reddit-sources/RedditSourceTable.tsx](lorewire-app/src/app/admin/(panel)/reddit-sources/RedditSourceTable.tsx) - bulk footer's Process form gets a `<select name="output_format">` with options *Default*, *Short only*, *Long-form*. Confirm dialog mentions which format will run.
- [lorewire-app/src/app/admin/(panel)/settings/page.tsx](lorewire-app/src/app/admin/(panel)/settings/page.tsx) - new section "Reddit imports" above "Article shorts", with `reddit.default_output` as a SettingSelect (Short / Long-form). Hint copy spells out which path runs and the cost difference.

### Python worker
- [pipeline/shorts_auto.py](pipeline/shorts_auto.py) - `maybe_enqueue_short_for_story(..., force: bool = False)`. When `force=True`, bypass the `shorts.auto.enabled` / per-category check but keep the rolling-24h cap (the cap is a cost safety net, not an opt-in gate).
- [pipeline/story_jobs_worker.py](pipeline/story_jobs_worker.py) - pure resolver `resolve_output_format(claimed_job, get_setting) -> 'short' | 'long'`. In `_default_process`, branch on the resolved format. When `'short'`: skip `_enqueue_video_render_for_story`, and call `maybe_enqueue_short_for_story(..., force=True)`. When `'long'`: existing behavior.

## Out of scope (flagged, not done)

- **Skipping `media.generate_media` when output_format=short.** Scene images are generated upstream of the video render. The short pipeline generates its own doodle frames, so the scene images we generate for short-only stories are partially wasted (the hero image and voice are still needed for the story page). This is a cost optimization worth maybe ~$0.10-0.30 per row, but it requires care: the story page still needs to render with at least a hero, and the audit trail for re-rendering as long-form later would break. Leave it for a follow-up after we see this default in production.
- **Per-subreddit override.** Possible to add later as a `reddit_source.output_format_override` column.

## Settings audit (rule 15)

- New setting: `reddit.default_output` in {`short`, `long`}, default `short`. Lives in a new "Reddit imports" section on the General settings page.
- The per-batch override is intentionally NOT a setting - it's a per-action choice. Stored on the row itself (`story_jobs.output_format`) so it's auditable per-row.

## Observability (rule 14)

- `[reddit output] resolved`, `{ reddit_id, job_id, format, source: 'row' | 'setting' | 'default' }` - logged on every claim.
- `[reddit output] short-only` - logged when the long-form video render is skipped.
- `[reddit output] forced-short` - logged when `maybe_enqueue_short_for_story` is called with `force=True`.
- TS side: `[story-jobs enqueue]` already exists; extended to include `output_format`.

## Security (rule 13)

- Closed enum on both sides (TS and Python). Bad values rejected; NULL/empty treated as "use default".
- No new user-supplied paths or PII surfaces.
- Cost direction is DOWN (short is cheaper than long-form), so the new default cannot cause a surprise cost spike. Daily cap (`pipeline.story_jobs.daily_cap_cents`) still applies upstream of all of this.

## Tests (rule 18)

### TS
- `bulkEnqueueStoryJobs` accepts `output_format`, writes it to the row.
- `bulkEnqueueStoryJobs` with no `output_format` stores NULL.
- Closed-enum defence: a bad value lands NULL on the row.

### Python
- `resolve_output_format` precedence: row override > setting > default.
- `resolve_output_format` rejects malformed setting values (treat as default).
- `maybe_enqueue_short_for_story(force=True)` bypasses the `shorts.auto.enabled` gate.
- `maybe_enqueue_short_for_story(force=True)` still respects the rolling-24h cap.
- `enqueue_story_job(output_format=...)` round-trips and rejects bad values.

## Manual QA plan

Run the dev server and walk through:
1. Settings page renders "Reddit imports" section with default `short`. Flip to `long`, save, verify persistence.
2. Reddit-sources list: select a row, click Process, see the new dropdown. Default selection is "Default".
3. Process with "Default" - confirm dialog reflects which format the global setting will produce. Worker resolves to that format.
4. Process with "Short only" - story_jobs row has `output_format='short'`. Worker logs show `source: 'row'`. No `video_renders` row. `short_renders` row exists.
5. Process with "Long-form" - story_jobs row has `output_format='long'`. Existing long-form path.
6. Worker logs are namespaced and grep-able for `[reddit output]`.
