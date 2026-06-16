# Story-job per-row event timeline + local-dev drain helper

**Date:** 2026-06-16
**Status:** Approved (full scope) — implementation in progress

## Goal

Solve two reported problems:

1. **"Nothing is moving" in local dev.** The Vercel cron at `/api/drain_story_jobs` only fires on deployed envs. Locally, nothing drains the queue, and the flash banner copy ("nothing to start locally") is misleading.
2. **No per-row "what is happening right now"** in the admin UI. Workers `print()` phase events to stdout; the admin can't see them.

## Why

Rule 14 says observability is first-class. Today story_jobs has `status`, `progress` (0/15/30/...), and `error`. That's a coarse 7-step bar with no narration. The admin's only way to see "this row is in `make_idea` right now" is to tail the worker terminal. Lazy users (rule 10) will not.

The short_renders pipeline already solved this exact problem with a `short_render_events` table + per-row timeline UI. We mirror it for story_jobs.

## Scope decisions (locked with the user)

The user picked **"All three"**: banner fix + event timeline + dev-drain helper. All ship in one commit on `feat/story-job-event-timeline`.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ pipeline/story_jobs_worker.py                                      │
│   _default_process:                                                │
│     store.log_story_job_event(job_id, 'claimed', ...)              │
│     store.log_story_job_event(job_id, 'idea_done', payload=...)    │
│     store.log_story_job_event(job_id, 'research_done', ...)        │
│     store.log_story_job_event(job_id, 'article_done', ...)         │
│     store.log_story_job_event(job_id, 'title_done', ...)           │
│     [if with_media] 'media_done'                                   │
│     [if short_only] 'short_force_enqueued' or 'long_skipped'       │
│     [if long-form] 'video_render_enqueued', 'auto_short_enqueued'  │
│     'finished' | 'failed'                                          │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────┐
        │ story_job_events table                  │
        │ id, job_id, ts, level, event,           │
        │ message, payload (JSON), reddit_id      │
        └─────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ /admin/reddit-sources/[reddit_id]                                │
│   StoryJobEventTimeline (mirrors ShortRenderEventTimeline)       │
│     auto-refreshes while job status in ('queued','processing')    │
│     stops polling once status is done/error                       │
└──────────────────────────────────────────────────────────────────┘
```

## Files touched

### Schema
- [lorewire-app/src/lib/schema.ts](lorewire-app/src/lib/schema.ts) — add `STORY_JOB_EVENTS` table (mirror of `SHORT_RENDER_EVENTS`).
- [pipeline/store.py](pipeline/store.py) — add CREATE TABLE + INDEX statements; helpers `log_story_job_event`, `list_story_job_events`. SQLite + Postgres parity, same patterns as short_render_events.

### Worker
- [pipeline/story_jobs_worker.py](pipeline/story_jobs_worker.py) — add `log_story_job_event` calls at every meaningful step in `_default_process`. Existing `print()` calls stay (the worker terminal still gets them). Event names are short, machine-readable enums; messages are the human-readable line.

### TS plumbing
- [lorewire-app/src/lib/story-jobs.ts](lorewire-app/src/lib/story-jobs.ts) — add `StoryJobEventRow` type, `listStoryJobEvents(jobId)`, `listStoryJobEventsForReddit(redditId)`.
- [lorewire-app/src/app/admin/(panel)/reddit-sources/[reddit_id]/page.tsx](lorewire-app/src/app/admin/(panel)/reddit-sources/%5Breddit_id%5D/page.tsx) — render `StoryJobEventTimeline` next to the existing job status.
- [lorewire-app/src/app/admin/(panel)/reddit-sources/[reddit_id]/StoryJobEventTimeline.tsx](lorewire-app/src/app/admin/(panel)/reddit-sources/%5Breddit_id%5D/StoryJobEventTimeline.tsx) — new client component, mirrors `ShortRenderEventTimeline`. Polls `getLatestStoryJobForReddit` + `listStoryJobEvents` while active, stops once finished.

### UX copy
- [lorewire-app/src/app/admin/(panel)/reddit-sources/page.tsx](lorewire-app/src/app/admin/(panel)/reddit-sources/page.tsx) — flash banner copy fixed. The "hosted cron runs..." line stays but adds a "(local dev: run `python -m pipeline.story_jobs_worker` to drain)" tail when `NODE_ENV !== 'production'`.

### Local-dev drain helper
- [lorewire-app/scripts/dev_drain.mjs](lorewire-app/scripts/dev_drain.mjs) — small Node script that polls `http://localhost:3000/api/drain_story_jobs` every 5 seconds. Uses CRON_SECRET from `.env.local`. Run via `npm run dev:drain`.
- Added to [lorewire-app/package.json](lorewire-app/package.json) scripts.

## Settings audit (rule 15)

No new settings. The event log is unconditional and not user-tunable. Future knob if it becomes noisy: a retention cap. Not in this cut.

## Observability (rule 14)

This IS the observability work. Beyond the new event log:
- Worker keeps `print("[story-jobs <event>] ...")` so the terminal still narrates.
- Event payloads include per-step context (token counts, scene counts, urls, error messages, durations) so the timeline isn't just headlines.
- Each event carries a `level` (info / warn / error) so the timeline can color-code at a glance.

## Security (rule 13)

- Event log writes are server-side only (worker + drain endpoint).
- Read path requires `requireAdmin()`.
- Payload JSON capped at 2KB per event to avoid log-bombing storage.
- Dev-drain helper requires `CRON_SECRET` from `.env.local` — same auth the prod cron uses. No new credential surface.

## Tests (rule 18)

### Python
- `log_story_job_event` round-trip (insert + read back).
- `list_story_job_events` ordering (by ts ASC, secondary by id).
- Payload cap enforced (oversize → truncated).
- Worker emits expected events on happy path (idea_done, research_done, article_done, title_done, finished).
- Worker emits `failed` event with error message on exception.

### TS
- `listStoryJobEvents` returns rows in ts ASC order.
- `listStoryJobEventsForReddit` joins through the latest job.

## Manual QA plan

1. Start `python -m pipeline.story_jobs_worker` against local Postgres.
2. Pick a queued reddit-source row, click into its detail page.
3. Watch the timeline live-update as the worker progresses: `claimed` → `idea_done` → `research_done` → `article_done` → `title_done` → `media_done` → `video_render_enqueued` / `forced-short` → `finished`.
4. Force a failure (e.g. unset an API key) and verify a `failed` event with the error message lands.
5. Flash banner now suggests starting the local worker in dev.
6. `npm run dev:drain` ticks every 5s and 200s on success.

## Out of scope (flagged)

- A "stop this row" button on the detail page. Bulk-stop already exists from the list page; per-row stop is a nice-to-have not in this cut.
- Retention / pruning of `story_job_events`. The table grows linearly with processed rows; revisit when it hits ~100k.
