# 2026-06-19 — Reddit-source jobs stop creating long-form videos

## Goal

When processing a Reddit source the worker should ship article + short + hero + thumbnail, **nothing else**. The long-form MP4 was burning ~$1.43 per story in kie scene gen plus Cloud Run render compute, and nothing on the public site reads from it for that path.

## What changes

- `media.generate_media(skip_long_form_scenes=True)` skips the 27-31 per-scene kie image generations. Narration + alignment still run.
- `story_jobs_worker._default_process` passes the new flag and no longer calls `_enqueue_video_render_for_story` for the auto path.
- The hero+thumbnail finisher (`_build_hero_and_thumbnail_from_short`) now also writes the short's scene URLs into `stories.images` via `store.update_story_scenes`. The article reader keeps inline illustrations — they just come from the short's 6-12 scenes instead of the long-form's 27-31.
- The same finisher now also **auto-applies the short as the story's video**: `stories.video_url` is set to the short's `output_url` via the new `store.update_story_video_url` helper (mirror of the TS `applyShortToStory` at [lib/short-render-queue.ts:303](lorewire-app/src/lib/short-render-queue.ts#L303)). No more clicking "Use as story video" on `/admin/shorts/[id]` — the moment the short is done, the story's video is it.
- `evaluatePublishReadiness` drops the `video_url` check. Stories can publish with body + hero + short.
- Manual "Render" button on `/admin/videos/[id]` stays — the editor + Cloud Run service are untouched so an admin can still render long-form on demand for a specific story.
- Manual "Use this short as the story's video" button on `/admin/shorts/[id]` stays as well — covers the edge case of re-applying after edits, but the common path no longer needs it.

## What does NOT change

- The Cloud Run render service, the video editor, the manual render button.
- The short video generation pipeline.
- The hero + thumbnail finisher (other than the side-effect of writing `stories.images`).
- Anything about non-Reddit-source story creation paths.

## Cost (rule 8)

| Path | Before | After | Saved |
|---|---|---|---|
| Long-form scene gen | 27-31 × $0.05 ≈ $1.43 | $0 | ~$1.43 |
| Cloud Run MP4 render | ~$0.05-0.15 compute | $0 | ~$0.05-0.15 |
| **Per Reddit-source story** | | | **~$1.50** |

At a 30-row "Process N selected" batch: ~$45 saved. At 200: ~$300.

## Security (rule 13)

- No new attack surface. Removing a queue enqueue + a database read can't add one.
- The publish gate is now strictly looser — a story with no MP4 can publish. That was already true for any non-Reddit-source path; we're just bringing Reddit-source into line.

## Observability (rule 14)

- `[media id={id} scenes] skipped — caller will populate stories.images from the short's scenes (saves ~$X)` on every Reddit-source job that takes the new path.
- `[hero+thumb from-short] id={id} wrote N short scene URLs into stories.images` after the handoff.
- `media_done` story-job event payload no longer claims `scenes: true`; just narration + alignment.

## Testing (rule 18)

- `test_media.py::generate_media skips scene loop when skip_long_form_scenes=True` (new).
- `test_hero_thumbnail_from_short.py::writes stories.images from short scene URLs` (new).
- `test_story_jobs.py` / `test_drain_story_jobs.py` need any assertions about `video_render_enqueued` or auto long-form to be updated.
- `reddit-source-readiness.test.ts` — flip the existing "blocks when video_url is missing" test to assert the opposite (no longer blocked).

## Rollback

- The change is additive on the parameter (`skip_long_form_scenes` defaults to `False` so any other caller is untouched).
- The publish gate change is a single deleted block. Restoring it brings the old behaviour back.
- The manual "Render" button still works, so any admin who needs a long-form MP4 isn't blocked.
