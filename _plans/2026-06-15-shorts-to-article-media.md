# Shorts scenes → article media (hero, OG, gallery)

Status: planned. Date: 2026-06-15. Approval: user picked Option A with the
explicit-linking variant + "direct replace with undo" semantics for all three
actions.

## Goal

When an article is linked to a story, and that story has a successful
`short_render`, the article editor surfaces the short's scene images and lets
the editor promote any frame into:

1. The article's `hero_image` (replaces existing)
2. The article's `og_image` (replaces existing)
3. The article's gallery (appends an `articleGallery` item to the Tiptap doc)

Works **post-render**: the editor reads the latest `short_renders.props`, so
re-running the short refreshes the available frames automatically. No manual
sync, no scheduled job.

## Rejected alternatives (and why)

- **Add an `article_media` table** as a per-article media library. More schema,
  more code, and still needs an article→story link to know which short to draw
  from. Reserved for a future iteration if we ever want articles to pull from
  multiple shorts or non-short sources.
- **Manual "Add image from short" modal with no FK.** Fails rule 10 — the user
  has to hunt for the right short every time. No automatic post-render surfacing.

## The data shape we are working from

Confirmed by code reading (see `_plans/...-shorts-to-article-media-research.md`
notes inline below):

- `short_renders.props` is JSON; the relevant field is
  `doodle_frames: [{id, url, caption_chunk_start_index, ...}, ...]`. URLs are
  public GCS HTTPS (no expiry). Source: `pipeline/shorts_render.py:185-200`.
- `short_renders.story_id` (TEXT) — references `stories.id`.
  `lorewire-app/src/lib/schema.ts:379-409`.
- `articles.hero_image` (TEXT), `articles.og_image` (TEXT), and
  `articles.document` (Tiptap JSON containing `articleGallery` nodes). Schema
  at `lorewire-app/src/lib/schema.ts:180-207`. Gallery edit UI at
  `lorewire-app/src/app/admin/(panel)/articles/[id]/GalleryView.tsx`.
- **No existing link** between articles and stories. Confirmed by Explore agent
  on 2026-06-15: zero shared keys; backfill is not tractable.

## Architecture

Three small additions:

1. **Schema change.** Add `articles.story_id` (TEXT, nullable, no FK constraint
   to match existing schema conventions). The `articles` table is **TS-owned**
   — `pipeline/store.py` only does SELECT/UPDATE against it and never issues
   a CREATE TABLE, so the only edit is `lorewire-app/src/lib/schema.ts` ARTICLES.
   The TS `ensureSchema()` path additively ALTERs the column in on first request,
   so there is no separate migration step on either side.

2. **Story picker in the article editor.** A small widget above the editor
   showing `Linked story: <title>` or `Linked story: none, [Link to story]`.
   The picker is a searchable dropdown of stories by title (mirrors the voice
   picker pattern at `lorewire-app/src/components/voice-picker/VoicePicker.tsx`
   — same search-as-you-type shape). Server action `setArticleStoryId(articleId,
   storyId | null)` patches the column.

3. **"Scenes from short" panel.** Shown only when `articles.story_id` is set
   AND the linked story has a `short_renders` row with `status = 'done'` AND
   `props.doodle_frames` is non-empty. The panel renders a grid of thumbnails
   (one per frame). Each thumbnail has a small action menu: *Set as hero*,
   *Set as OG image*, *Add to gallery*. Default-open below the metadata block
   in `ArticleEditor.tsx` so the user sees it without scrolling.

### Server actions (in `lorewire-app/src/app/admin/(panel)/articles/[id]/actions.ts`)

- `setArticleStoryId(articleId: string, storyId: string | null)` — patches
  `articles.story_id`. Returns the new value. `requireAdmin()` gate.
- `setArticleHeroFromFrame(articleId: string, frameUrl: string)` — captures
  the previous `hero_image` in the returned payload (for undo), then patches
  to the new URL.
- `setArticleOgFromFrame(articleId: string, frameUrl: string)` — symmetric
  with hero.
- `addArticleGalleryImageFromFrame(articleId: string, frame: {url, alt})` —
  appends an `articleGallery` node to `articles.document`. Returns the
  pre-change document (for undo). Gallery insertion follows the existing
  Tiptap node shape used in `GalleryView.tsx`.
- `revertArticleHero(articleId: string, previousUrl: string | null)` — undo
  primitive.
- `revertArticleOg` / `revertArticleGallery` — symmetric.

### UI

- `LinkedStoryWidget.tsx` — the picker + current-link display.
- `ShortScenesPanel.tsx` — reads `short_renders` for the linked story,
  renders the grid + actions.
- Each action shows a `Sonner` toast with an `Undo` button (10 s timeout).
  Click `Undo` calls the matching `revertArticle*` action with the captured
  previous value. (Sonner is already wired into the admin shell.)

## Security (rule 13)

- All five new server actions are `requireAdmin()` gated, same as existing
  article actions.
- Inputs: `articleId` and `storyId` are validated as known IDs (existence
  check via `db.get(articles)` / `db.get(stories)`); `frameUrl` is constrained
  to URLs originating from the linked story's own `short_renders.props` —
  the action **does not accept arbitrary URLs** as input. It receives a
  `frameId`, looks up the URL server-side from `short_renders.props`, and
  uses that. This prevents an admin from accidentally (or maliciously) setting
  the hero image to an off-platform URL via this code path.
- Undo: previous values are returned to the client, never persisted in the DB.
  An expired Undo cannot re-target the hero to a stale URL because the client
  must re-submit the explicit URL and the server validates it belongs to the
  current short.
- No new attack surface from the asset side: frames are already public GCS
  URLs the article would otherwise embed.

## Observability (rule 14)

Per the standing rule, every action gets a namespaced log on both sides.

Server actions (`logger.info` in `actions.ts`):

- `[article-media link-story]` — `{ articleId, storyId, previousStoryId }`
- `[article-media set-hero]` — `{ articleId, frameId, frameUrl, previousUrl }`
- `[article-media set-og]` — `{ articleId, frameId, frameUrl, previousUrl }`
- `[article-media add-gallery]` — `{ articleId, frameId, frameUrl, position }`
- `[article-media revert-hero]` / `revert-og]` / `revert-gallery]` — `{ articleId, restoredFrom, restoredTo }`

Client (`console.info` in the React components):

- `[article-editor link-story]` — `{ articleId, picked }`
- `[article-editor scenes-loaded]` — `{ articleId, storyId, frameCount }`
- `[article-editor apply-frame]` — `{ articleId, frameId, action }`
- `[article-editor undo]` — `{ articleId, action, restored }`

All payloads carry the actual values (not just booleans) per the standing
"log the actual values" rule.

## Settings (rule 15)

Walked the audit: nothing in this feature needs a user-facing setting.

- Replace-vs-confirm semantics for hero/OG: user already chose "direct
  replace with undo" — making this a setting would over-engineer it.
- Gallery insert position: defaults to append; reorder is already supported
  by `GalleryView.tsx`.
- Linked-story scope: per-article only; no global default makes sense.

Explicitly out of scope for a setting now: which actions are visible on a
thumbnail (hero/OG/gallery) — if any team wants to disable e.g. OG override
later, that's a future setting. Not solving it pre-emptively.

## Testing (rule 18)

Unit tests live alongside the action files (`actions.test.ts`) and use the
existing repo helpers / SQLite fixture. New tests:

- `setArticleStoryId` — sets, unsets, rejects non-existent IDs.
- `setArticleHeroFromFrame` — patches `hero_image`, returns the previous URL.
  Negative: rejects when the `frameId` is not in the linked short's frames.
  Negative: rejects when the article has no linked story.
- `setArticleOgFromFrame` — symmetric.
- `addArticleGalleryImageFromFrame` — appends to the Tiptap document, position
  is the previous last + 1.
- `revertArticleHero` — restores the previous URL string (including null).
- Integration: open an article via the editor's data loader, with a linked
  story that has a `short_renders` row → asserts `frames` are exposed; without
  a link or without a successful render → asserts panel is hidden.

Component tests for `LinkedStoryWidget` and `ShortScenesPanel` use the
existing React Testing Library pattern (see
`lorewire-app/src/components/voice-picker/VoicePicker.test.tsx`):

- Widget: typing into the search filters the dropdown; selecting calls the
  action; "Unlink" sets to null.
- Panel: renders one thumbnail per frame; clicking the menu triggers the
  matching action; undo toast appears.

Out of scope explicitly: end-to-end happy-path on Cloud Run-rendered shorts
(covered by the existing short_render integration tests upstream).

## Files touched (estimate)

- `pipeline/store.py` — SCHEMA_STATEMENTS: add `story_id` to articles.
- `lorewire-app/src/lib/schema.ts` — ARTICLES: add `story_id`.
- `lorewire-app/src/lib/articles.ts` (or `repo.ts`) — `getLinkedShortFrames(articleId)`
  helper that does the article → story → short_renders → frames chain.
- `lorewire-app/src/app/admin/(panel)/articles/[id]/actions.ts` — 5 new
  server actions + 3 revert actions.
- `lorewire-app/src/app/admin/(panel)/articles/[id]/LinkedStoryWidget.tsx` — new.
- `lorewire-app/src/app/admin/(panel)/articles/[id]/ShortScenesPanel.tsx` — new.
- `lorewire-app/src/app/admin/(panel)/articles/[id]/ArticleEditor.tsx` — mount
  the widget + panel.
- Tests: `actions.test.ts`, `LinkedStoryWidget.test.tsx`,
  `ShortScenesPanel.test.tsx`.

Total: ~6 production files + 3 test files. ~400 LOC.

## Out of scope

- Multi-short article media (an article pulling scenes from several shorts).
- Story → article reverse-link (do not need it for this feature).
- Bulk "import all scenes as gallery" — single-click per frame is enough.
- Sheets-import auto-linking — leave for the importer epic.
