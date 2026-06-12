# Changelog

Significant changes that landed on `main`. Authored against the
working-as-of-2026-06-12 codebase. Older history lives in `git log`.

## 2026-06-12 — Admin Studio overhaul

Single-session push that reshaped the admin from a wall of pages into a
coherent "studio" surface, paired with full SEO support, an asset
re-render system across both languages, and a Phase 3 captions
in-editor experience.

### Admin shell + IA

- **Sidebar Studio** (`d288c03` → `d2aa91d`). Replaced the top-tab
  `AdminNav` with a left sidebar layout. Final shape: Overview ·
  Content · Settings. Stories renamed to Videos throughout the sidebar
  (deep-link URLs preserved). `/admin/articles` and `/admin/videos` are
  filtered views of the unified Inbox at `/admin/content`.
- **Settings hub** (`d57c54d`, `689af17`). `/admin/settings` becomes a
  category dispatcher with sub-nav General · Models · SEO · Intros &
  outros. `/admin/templates` retained as a deep-link-only surface for
  global caption defaults; per-video captions move into the editor
  (see Phase 3, below).
- **Style presets section** (`47aefdd`). Top-of-Settings/General home
  for the two creative-direction fields (`video.style`,
  `voice.google_style_prompt`) with preset chips on each.
- **Inline polish** — toggles for booleans, number steppers for counts,
  preset chips for textareas (`12d954d`).
- **API-backed pickers** (`f53c28b`): Google voices + ElevenLabs voices
  dropdowns sourced from the providers' list endpoints, with a
  graceful fall-back to free text input when credentials are missing.
  Subreddit autocomplete via Reddit's public search endpoint.
- **Breadcrumbs + a Cmd-K stub** on every panel page (`d288c03`,
  `37f524a`). Cmd-K reserves the keybind and explains itself; a real
  command palette lands later.
- **Account page** at `/admin/account` (this commit), reachable from
  the user menu. Read-only today; password / profile edit are queued.
- **Theme toggle** (this commit). Real light theme via CSS-variable
  overrides on `[data-theme="light"]`. ThemeProvider persists the
  choice to `localStorage` and tracks `prefers-color-scheme` when
  choice is "system". Pre-hydration script in the root layout
  prevents FOUC on first paint.

### SEO

- **Sitewide SEO settings page** (`689af17`). Site identity, social
  cards, Schema.org Organization, search-engine verification metas,
  sitemap policy. All persisted to `settings_kv` under `seo.*`.
- **Public reader integration** (`eb45584`). `app/layout.tsx`,
  `articles/[locale]/[slug]/page.tsx`, and `v/[slug]/page.tsx` all
  read `seo.*` settings via `lib/site-seo.ts`. Title template, OG
  card type, Twitter handle, default OG image, verification metas
  flow through automatically.
- **Per-row noindex toggle** on articles (`eb45584`) and stories
  (`1f29bda`). Surfaces in the editor sidebar; the public reader
  emits `robots: noindex,nofollow` when set; sitemap + RSS + article
  list exclude noindex pieces.
- **LLM auto-fill** in the article SEO panel (`3c8c2a4`). One Generate
  button → kie.ai or OpenAI returns meta_title, meta_description, 5-
  10 keyword ideas, og_image_alt. Suggestions render with per-row
  Apply buttons.
- **kie.ai LLM gateway** wired alongside OpenAI (`9924620`).
- **Public story reader** at `/v/[slug]` (`f23cf5c`). Mirrors the
  article reader's metadata shape; respects noindex; emits OG video
  card when `story.video_url` exists.
- **Sitemap** at `/sitemap.xml` (this commit). Enumerates published
  articles and stories, respects `seo.sitemap_max_age_days`, omits
  noindex pieces.

### Asset re-render

A full per-asset image regeneration system across the TS admin + Python
pipeline.

- **Queue + worker** (`5bb5b59`, `5d7c9a7`). New `image_renders` table
  mirrors `video_renders`. TS-side `enqueueImageRegenAction` writes
  the row; Python `image_render_worker.py` drains it. Status
  transitions queued → generating → done | error. Daily budget guard
  reuses `budget.daily_usd` from the existing pipeline cap.
- **Story side** (`3e0bb50`, `df5b6bd`). UI in `/admin/stories/[id]`
  for hero, all scenes, all props (gated on `video.prop_slide`),
  and mouth-swap (gated on `video.mouth_swap`). Python implementations
  in `media.regen_one()` rebuild each asset and patch the relevant
  `stories.*` column.
- **Article side** (`15a8d54`, `c65cc8b`). UI in
  `/admin/articles/[id]` for hero, OG image, all body images, all
  gallery items. New `article_media.py` walks the Tiptap doc to
  surface per-node regen for both body and gallery items;
  `articles.document` is rewritten atomically.
- **Per-image granular regen** (`9992f1a`). New `GranularRegenGrid`
  component shows a thumbnail per scene / prop / body image /
  gallery item with its own "Redo" button. Slugs: `scene:N`,
  `prop:N`, `body:N`, `gallery:N`. Python paths splice the regenerated
  URL into the existing list / doc, leaving every other element
  verbatim.
- **Caption-vs-label fix** (`9992f1a`). Gallery items store
  `{src, alt, caption}` — earlier code was reading `item.get("label")`
  and silently getting None. Cleared up before per-image regen would
  have shipped the same bug.

### Captions in the editor (Phase 3)

- **Caption style tab** at `/admin/videos/[id]` (`3ab07da`). Edits
  the per-story caption template (color, position, size, typography,
  motion). Resolver in `lib/caption-style.ts` walks the chain
  story → category → global → defaults. Each field surfaces its
  source via a badge; "Clear override" removes the per-story value.
- **Live preview** updated. `PreviewComposition.CaptionBand` reads
  caption style from props with a fallback to the historical
  hardcoded values for backward compat.
- `/admin/templates` retained as the deep-link surface for
  global + per-category caption defaults.

### Tests

Started the session at ~244 tests. Ended at:

- **304 Node tests** (`vitest`).
- **268 Python tests** (`pytest`).
- **572 total**, up from 244.

`npm run lint`: **0 errors** (down from 3 pre-existing at session
start), 34 warnings.

### Plans

Living documents updated as scope was confirmed or deferred:

- `_plans/2026-06-11-admin-reorg.md` — the original reorg plan.
- `_plans/2026-06-12-admin-reorg-phase2.md` — Phase 2 + Phase 3
  (latter marked DONE).
- `_plans/2026-06-12-asset-rerender.md` — approved, all four
  commits landed.
- `_plans/2026-06-12-seo-and-indexing.md` — scoping doc; all four
  items shipped (sitewide settings, public reader, noindex, LLM
  auto-fill).
