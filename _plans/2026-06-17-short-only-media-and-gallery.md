# Short-only media + single-image gallery

**Date:** 2026-06-17
**Status:** Approved + implementing

Two changes the user asked for in one pass. They are independent (one is the
Python pipeline, one is the public reader UI) but ship together.

## Part A — stop generating the 16:9 long-form assets for short-only stories

### Problem

Reddit imports already default to a short (PR #31, 2026-06-16). But the worker
still runs the FULL `media.generate_media` for them, which generates the
long-form scene set (up to 60 kie images), prop cutouts, the mouth-swap bust,
and a full-article voiceover. For a short-only story none of that is used: the
short pipeline renders its own 9:16 doodle frames and its own narration, and the
story page reads those live (see `getLiveStoryMedia` — a short reads its own
frames + voiceover, falling back to the long-form columns only when the short
has none, which never happens by publish time because the publish gate requires
`video_url`). So the long-form assets are generated only to be thrown away —
roughly $1.30-3.30 of wasted kie + TTS per story.

This was flagged as out-of-scope in `_plans/2026-06-16-reddit-default-to-shorts.md`;
the user has now asked for it.

### What we keep vs skip (short-only path)

- **Keep:** the cinematic hero thumbnails (portrait 3:4 + landscape 16:9). The
  homepage cards, billboard, and posters read `hero_image`; the short does not
  produce a thumbnail, so we still need these.
- **Skip:** scene images, prop cutouts, mouth-swap bust, and the full-article
  voiceover (+ the `make_image_prompts` LLM call that feeds the scene set).

### Implementation

- `pipeline/media.py` — `generate_media(..., short_only: bool = False)`. When
  True: init `scene_urls=[]`, skip the `make_image_prompts` call + scene loop,
  skip props, skip mouth-swap, skip voice. Cost math already keys off
  `scene_urls` / `out["alignment"]`, so the per-story cost falls out correctly;
  also zero out `narration_chars` for the short path. Default `False` keeps
  `run.py` (manual CLI scraper) and every other caller unchanged.
- `pipeline/story_jobs_worker.py` — resolve `output_format` BEFORE the media
  step (it was resolved after), and pass `short_only=(output_format == "short")`
  into `generate_media`. The existing short/long hand-off branch below reuses
  the already-resolved value.

### Why it is safe

- The publish gate (`video_url IS NOT NULL`) means a short-only story is never
  public until its short is applied, so the live-media fallbacks to
  `stories.images` / `stories.audio_url` are never hit in the published view.
- Cost direction is strictly DOWN.
- `output_format` resolution is unchanged (row override > setting > 'short').

## Part B — Read → Gallery: one image at a time + caption below (mobile + desktop)

### Problem

Both `AppShell` (mobile) and `DesktopShell` (desktop) render the gallery as a
horizontal multi-card strip. Desktop shows ~3 tall 9:16 cards at once; the
per-card caption sits below each card, pushed off the visible modal area, so it
reads as "no caption on desktop." The user wants a single-image carousel: one
scene at a time, a clear Next/Prev control, and the caption directly under the
image — on BOTH breakpoints.

### Implementation

- Replace the multi-card strip in both shells' `Read` gallery branch with a
  one-at-a-time `GalleryCarousel`: a single card (image + `SCENE N` chip),
  always-visible prev/next arrows on the image edges, the caption directly
  below, and a `n / total` position counter. Clamp at the ends (disable the
  arrow, dim it) so the user always knows where they are — better for a
  first-look "lazy user" than silent wrap-around.
- Data source unchanged: `_galleryFromStory(story, liveMedia)` already returns
  `{ src, caption }[]` (short frames + spoken-line captions for reddit shorts).
- Remove `GalleryScroller` from `DesktopShell` (its only use). Keep `Dots` in
  `AppShell` — the legacy sample-gallery fallback still uses it.

## Tests

- `pipeline/tests/test_media.py` — `short_only=True` (dry-run, offline) returns
  `hero_image` and NOT `images`/`audio_url`/`alignment`/`props`, and does not
  call `make_image_prompts`. Contrast: `short_only=False` still yields scenes +
  voiceover.
- `pipeline/tests/test_story_jobs.py` — `_default_process` passes
  `short_only=True` to `generate_media` when the format resolves to short, skips
  the long-form render, and force-enqueues the short; `short_only=False` enqueues
  the long-form render.

## Out of scope

- Deriving the hero from the short's poster instead of a separate kie call.
  Possible later saving (~$0.08-0.18/story) but riskier (timing: the short is
  not rendered when the story is created) and the homepage needs a thumbnail
  the moment the story exists.
- Converting the legacy hardcoded sample gallery to the carousel.
