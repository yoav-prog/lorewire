# Video stage: port yt-studio doodle_explainer_2_short

Date: 2026-06-10
Status: in progress
Section in handoff: 3.2

## Goal

Render each story as a vertical 1080x1920 MP4 in the same doodle aesthetic
yt-studio ships for its Shorts Creator, but durationally tuned to LoreWire
articles (1:30-4:00 instead of YouTube's 60s cap). Feeds from the columns
3.1 just populated (`hero_image`, `images`, `audio_url`, `alignment`) and
writes `video_url` back to the story row.

## Decisions

- **Port the visual contract from `DoodleShortVideo` in yt-studio**
  (`_reference/youtubestudio/src/remotion/compositions/ShortVideo.tsx:357`),
  not the data model. Their composition expects a `ShortVideoConfig` we will
  build from our simpler inputs (4 images + audio + word timings + title).
- **Vertical 1080x1920** at 30 fps. The yt-studio composition is built for it
  and the LoreWire UI is mobile-first, so vertical is a natural fit.
- **Remotion 4.x in a sibling repo at `/video/`** — a focused Node project,
  not a Vercel app. The pipeline shells out via `npx remotion render`.
- **Static images, not i2v** for v1. The composition's `animation_url` branch
  (yt-studio's image-to-video) is left in but we never set it; once kie.ai's
  motion model is wired we flip our `doodle_frames` to include it.

## Architecture

### `/video/` (new Remotion project)

```
video/
  package.json          # remotion + react + minimal deps
  tsconfig.json
  remotion.config.ts
  src/
    Root.tsx            # registerRoot, registers DoodleShort
    DoodleShort.tsx     # the ported composition
    caption-style.ts    # resolveDoodleCaptionStyle + entryEffectTransform (ported)
    caption-words.ts    # findActiveWordIndex (ported)
    types.ts            # ShortVideoConfig (subset), DoodleFrame, ShortCaptionChunk
```

The composition reads props from a JSON file the pipeline writes to
`video/.props/<id>.json` and exits cleanly on render completion.

### `pipeline/video.py` (new)

```python
def generate_video(story_id, title, image_paths, audio_path, alignment,
                   repo_root) -> dict:
    """Render the doodle short for a story; return {'video_url': '/generated/<id>/video.mp4'}."""
```

Responsibilities:

1. Build `ShortVideoConfig` from inputs:
   - `voiceover_url`: file:// path to local mp3 (Remotion renders are local).
   - `title`: short brand title (we use the article's title, truncated).
   - `doodle_frames`: even distribution of the 4 images across the duration,
     with `caption_chunk_start_index` set to the appropriate chunk.
   - `captions`: word-timing JSON chunked into 2-4 word phrases.
   - `duration_ms`: derived from the last alignment word's end time.
   - `channel_name`: "lorewire".
   - `style_id`: `"doodle_explainer_2_short"`.
2. Write props JSON to `video/.props/<id>.json` (gitignored).
3. Shell out to `npx remotion render` against `video/src/Root.tsx`.
4. Copy the MP4 to `lorewire-app/public/generated/<id>/video.mp4`.
5. Return `{video_url: "/generated/<id>/video.mp4"}` for `store.upsert_story`.

### `pipeline/run.py`

`--video` flag chains after `--media`. Order: scrape -> research -> article
-> images + voice (--media) -> video (--video). Without `--media` first, the
video step has nothing to feed on and exits with a clear error.

## Word chunking (caption phrases)

Group consecutive words into chunks. Break on:

- Hard max: 4 words per chunk.
- Punctuation within a word (.,!?:;).
- Pause to next word > 400 ms.

Each chunk gets `start_ms`, `end_ms`, `text`, `words` (with their word-level
timings preserved so the karaoke highlight tracks word-by-word).

## Frame distribution

For N=4 images and a duration of D ms:

- Hero gets `[0, D * 0.20)`.
- Scenes 1..3 split the remaining 80% in equal thirds.
- Snap each frame's start to the nearest caption chunk boundary so the cut
  happens on a clean phrase break, not mid-word.

This is the v1; if the user wants smarter pacing (cuts on topic pivots, hold
longer on the hero, etc.), we tune later.

## Observability (rule 14)

Namespaced logs at every step:

```
[video id=X] start (duration ~2:34, 4 frames, 38 caption chunks)
[video id=X props] wrote video/.props/X.json (3.2 KB)
[video id=X render] launching npx remotion render DoodleShort -> .out/X.mp4
[video id=X render] frame 600/4620 (13%)         # Remotion's own progress
[video id=X render] done in 184s
[video id=X publish] copied to lorewire-app/public/generated/X/video.mp4 (4.7 MB)
```

## Security (rule 13)

- Same `_sanitize_id` regex from media.py reused before any path forms.
- We pass props as a **JSON file** via `--props`, never as a shell arg, so
  the article body can't escape the command line.
- `npx remotion render` runs locally with no network exposure.
- The `.props/` directory is gitignored (props contain absolute file paths
  and our brand title, nothing secret, but no reason to commit them).

## Cost (rule 8)

Compute, not API: rendering happens on our machine.

- One-time install: Remotion (~500 MB node_modules) + headless Chromium
  (~150 MB) + ffmpeg (bundled). Pay it once on each machine.
- Per-render: ~real-time on a modern laptop (a 2:30 video takes ~2-3 min to
  render at 30 fps, 1080x1920). No per-render dollar cost.

## Testing (rule 18)

`pipeline/tests/test_video.py` covers pure-logic only (no render):

- Word chunking: 4-word cap, punctuation break, long-pause break, empty
  input.
- Frame distribution: 4 frames across N captions; snapping to chunk
  boundaries; degenerate cases (0 frames, 1 frame, more frames than
  chunks).
- Title truncation: long titles fit a single chunk band.

The composition itself is visual; trust falls on a real render in QA.

## QA plan (rule 6)

1. `python -m unittest discover -s pipeline/tests` still green.
2. `cd video && npm install` succeeds.
3. `npx remotion preview` from `/video/` boots and opens the preview at a
   sample-props bundle.
4. `python -m pipeline.run --fixture --media --video` renders one real
   story end to end. Verify:
   - `video/.props/envelope.json` exists with the right shape.
   - `lorewire-app/public/generated/envelope/video.mp4` exists, plays, is
     vertical 1080x1920, and the captions track the audio.
   - `video_url` column populated on the DB row.

## Rejected alternatives

- **Wholesale port of yt-studio's production-doc + Atlas pipeline + style
  config.** Out of scope — 1751 lines of style config tied to their schema.
- **Pure ffmpeg pipeline.** Loses every doodle-specific animation
  (karaoke captions, title chip pop, smooth crossfades). Wrong call for a
  brand identity project.
- **Render through a hosted service (Vercel Functions, Lambda).** Adds cost
  and infra. Local renders fit our 5-10 stories/day cadence.
