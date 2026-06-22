# Article shorts — session handoff (2026-06-15)

Pick-up notes for the next Claude Code session. Branch: `feat/article-shorts`.
Everything below is already committed and pushed unless marked PENDING.

## Where things stand

Branch `feat/article-shorts`, origin in sync, working tree clean (only untracked
scratch dirs `_spike/` and `ref/`, do not commit them).

Pushed this session, newest first:
- `6855835` Regenerate button — force a fresh short (fixes "Generate short not responding")
- `bc3b655` Global daily cap on the auto-generate path + clear started_at in store_short_props
- `7923bce` Captions fixed to match yt-studio + queue hardening (M8/M9/M11, attempts ceiling, stale threshold)

## THE most important outstanding action (user must do this)

The caption fix will NOT appear in prod until the Cloud Run render container is
rebuilt. The caption code lives in `video/src/DoodleShort.tsx`, which Cloud Run
bundles at build time. Vercel deploys the queue/UI/Python drain but NOT the
renderer. Redeploy:

```bash
cd video
npm run deploy:cloud-run
```

Runs `gcloud run deploy lorewire-render --source .` (~90s). Needs these in the
shell env (same vars Vercel uses): `CRON_SECRET`, `GCS_BUCKET`,
`GCS_CLIENT_EMAIL`, `GCS_PRIVATE_KEY`. See `video/README-cloud-run-setup.md`.
Claude cannot run this (no gcloud creds; it is an outward action on the cloud
account). After it deploys, regenerate a short and the captions are clean.

Why captions were broken: an earlier pass replaced yt-studio's outline technique
(`-webkit-text-stroke` + `paintOrder: 'stroke fill'`) with an invented 28-layer
text-shadow ring, which rendered as lumpy "weird shapes." Reverted to match
`_reference/youtubestudio/src/remotion/compositions/ShortVideo.tsx:581`.

## PENDING feature — "use the short's images for the article images + gallery"

This was the last request and is NOT started. There is a real blocker that needs
a decision before any code:

- In this codebase, ARTICLES and STORIES are SEPARATE tables with NO link
  (no `articles.story_id`, no join). The short is generated for a STORY
  (e.g. "envelope") in the video editor. "Article images and gallery" points at
  the separate articles CMS. So: which entity should receive the frames, and if
  articles, how to pick which article (no story->article link exists)?

Decision needed (ask the user):
- (A) Attach to the STORY's own images: `stories.images` (TEXT/JSON) and/or
  `stories.hero_image`. Simplest, same entity the short was made for.
- (B) Attach to a specific ARTICLE: set `articles.hero_image` and inject an
  `articleGallery` node into `articles.document` (Tiptap JSON). Needs the admin
  to choose the target article id since there is no automatic link.

Data model facts already gathered (so no need to re-explore):
- Short frames: `short_renders.props` (JSON string) -> `doodle_frames[].url`.
  In prod those are GCS https URLs, key pattern `<storyId>-short/frame-NN.png`.
  `ShortRenderRow.props` (lib/short-render-queue.ts) exposes the JSON.
  Read the latest done short for the story, `JSON.parse(props)`, pull
  `doodle_frames[].url` (skip the base/character frame if you only want scenes).
- Story images: `stories.images` (TEXT JSON), plus `hero_image`,
  `hero_image_landscape`, `character_image`.
- Article images: `articles.hero_image` (TEXT), `articles.og_image` (TEXT),
  and gallery lives inside `articles.document` Tiptap JSON as `articleGallery`
  nodes whose `items` are `GalleryItem { src, alt, caption }`
  (lib/tiptap-gallery.ts:10-14).
- Existing write helpers to mirror: Python `store.update_article_hero`,
  `store.update_article_document` (store.py ~2190-2247); TS `repo.updateArticle`
  (lib/repo.ts). For the story path, mirror `applyShortToStory` in
  lib/short-render-queue.ts (a simple pointer-swap UPDATE).
- UI: short controls are in
  `lorewire-app/src/app/admin/videos/[id]/ShortRenderControl.tsx`. Article
  editor + gallery in `lorewire-app/src/app/admin/(panel)/articles/[id]/`
  (`page.tsx`, `GalleryView.tsx`). A "Use short images" button likely belongs in
  ShortRenderControl next to "Use as article video".

Suggested implementation once (A) vs (B) is settled: a server action
`useShortImagesFor...(storyId, renderId)` that reads the short's props, extracts
the frame URLs, and writes them to the chosen target, plus a button in
ShortRenderControl. Keep it reversible.

## LOW polish remaining (non-urgent)

- Settings page number inputs for the two cap keys (error messages reference them
  but there is no UI control yet): `shorts.daily_renders_per_story` (per-story
  on-demand cap, default 20) and `shorts.auto.daily_cap` (global auto cap,
  default 50). Add to the settings Shorts section.
- Narrow `chunk_for_planning` regex in `pipeline/shorts.py` to strip only
  `[VISUAL...]` tokens (currently strips all `[...]`). Low value now that the
  narration styles dropped `[VISUAL]`.
- Dead-code cleanup deferred as too risky to do blind: unused
  `cost_credits`/ShortAssets fields, `shorts_image_style.py` VISUAL_STYLES
  exports, and the larger store.py/route duplication. Treat as a separate
  careful refactor.

## Verification baseline (so you can tell new breakage from old)

- Both TS projects typecheck clean EXCEPT these PRE-EXISTING test-file errors
  (ignore them; they predate this work): `useDebouncedSave.test.tsx` renderHook,
  `tests/lib/article-payload.test.ts` datelineLocation, `article-seo.test.ts`
  noindex, `pipeline-cache-cleavage.test.ts` ShortVideoConfig cast.
- Python compiles (`python -m py_compile`). Smoke tests passed this session for
  the reaper attempts ceiling, the props-IS-NULL claim guard (M11), COALESCE on
  the TS-created attempts column, and the global auto cap (M10).

## Deploy split (remember this)

- Vercel (auto on push / promote): routes, admin UI, Python generation drain,
  queue logic, regenerate, caps. Picks up `7923bce`/`bc3b655`/`6855835`.
- Cloud Run (manual redeploy): captions and anything else in `video/src/` —
  bundled into the render container. See the top section.
