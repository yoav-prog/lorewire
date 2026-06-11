# SEO settings + per-page no-index

Date: 2026-06-12
Status: **Scoping draft** — not approved, not yet branched. Captures the
user's request so the next session can build it without re-discovery.

## What the user asked for

> add a robust SEO page for the site, With all robust, extreme, best
> practices SEO settings to choose from, With a model picker to choose
> for to fill it automatically for us, Add all the ones that are relevant
> from kie.ai

> and include an option to not index a page, for example the /admin page

So two things:

1. **Site-wide SEO settings page** with the full best-practice surface,
   plus an LLM-driven "auto-fill" backed by a model picker. Models pulled
   from kie.ai (the same gateway already used for image gen).
2. **Per-page no-index** control, with `/admin` no-index by default.

## What exists today

- **Per-article SEO is partially built.** [`article-seo.ts`](lorewire-app/src/lib/article-seo.ts)
  builds JSON-LD, and the article editor has [`ArticleSeoPanel`](lorewire-app/src/app/admin/(panel)/articles/[id]/ArticleSeoPanel.tsx).
  Per-article slug, meta_title, meta_description, og_image are stored on
  the `articles` row.
- **Site-wide SEO does not exist.** No defaults table, no fallback for
  pieces missing per-page fields, no organization-level JSON-LD.
- **Robots / no-index** is not configured anywhere I've found. Next.js
  apps typically handle this via `app/robots.ts` (sitewide) and the
  per-page `metadata.robots` export. Verify with Context7 before
  building — Next 16 may have changed the API surface.
- **kie.ai** is already on the books as the image generator. It also
  offers an LLM gateway (Gemini, Claude, GPT family, Qwen, DeepSeek,
  etc.). The Models page in Settings exposes the existing model picker;
  this work extends that picker to SEO auto-fill.

## Open questions

1. **Sitewide vs. per-piece scope.** Are the SEO settings *defaults*
   that per-piece fields override, or are they the only knobs (per-piece
   inheriting silently)? I'd recommend defaults + override — matches the
   existing caption template tier model.
2. **Auto-fill UX.** "Fill the SEO fields automatically using a model" —
   one button per field, or one "Generate SEO" button that fills all
   blank fields at once? One-shot is friendlier; per-field is more
   surgical.
3. **Cost flagging.** Each auto-fill is one LLM call. With kie.ai
   routing, costs vary by model. Per rule 8, the picker should show
   estimated $/run next to each model. The Models page already has a
   `cost` column on the option list — re-use that pattern.
4. **No-index granularity.** Per route vs. per row.
   - **Per route**: a config table mapping `path_pattern` → `noindex`.
     Engineering-leaning, hard for a non-dev to manage from the UI.
   - **Per row**: a `noindex` boolean on `articles` and `stories`.
     Friendly toggle in the editor sidebar. Default off (= indexable);
     turn on for sensitive pieces.
   - `/admin/*` is its own answer — that's static, handled in
     `app/robots.ts` and `app/admin/layout.tsx` metadata, not a per-row
     toggle.
5. **Multi-language.** Articles support multiple languages (EN / HE /
   ...). Site-wide SEO defaults need a language axis or they leak the
   default language's copy into translated pages.

## Best-practice SEO surface (what "robust" should include)

Site-wide (Settings → SEO):

- Site name (defaults to "LoreWire")
- Site URL (canonical origin)
- Default title template (e.g. `%s · LoreWire`)
- Default meta description
- Default OG image
- Default Twitter card type (`summary_large_image`)
- Twitter handle
- Facebook app id (if used)
- Theme color
- Default `robots` policy (index/follow + advanced flags)
- Organization JSON-LD: name, logo URL, sameAs URLs (social)
- Author JSON-LD defaults
- Google Search Console verification meta
- Bing webmaster verification meta
- Default `hreflang` strategy
- Sitemap configuration: include drafts? include archived?

Per-page (already partly there for articles, mirror onto stories /
videos / etc.):

- meta title (override or template)
- meta description
- canonical URL override
- OG title, description, image
- Twitter title, description, image
- Schema.org type (Article / NewsArticle / VideoObject / Review)
- Author override
- Reading time / word count (auto-derived)
- `noindex` toggle (per-row flag)
- `nofollow` toggle
- Last modified hint

Auto-fill button → calls kie.ai with the article body, returns:
- meta title (≤60 chars)
- meta description (≤160 chars)
- OG title / description
- 5–10 keyword candidates (informational only — Google ignores keywords
  but useful as content checks)
- Suggested canonical slug

Each suggestion shows up as a fill-in chip; admin clicks Accept on what
they want.

## No-index implementation sketch

- **Sitewide static**: `app/robots.ts` exports rules; `/admin/*` is
  `Disallow`. Verify Next 16 API via Context7 before writing.
- **Per-admin-route**: each route group's `layout.tsx` can export
  `metadata` with `robots: { index: false, follow: false }` so the meta
  tag emits even if a search engine ignores robots.txt.
- **Per-row toggle**: add `noindex INTEGER DEFAULT 0` to `articles` and
  `stories`. The public reader pages read it and emit
  `<meta name="robots" content="noindex,nofollow">` when set.
- UI: a single switch in the editor sidebar — "Hide from search engines."
  Plain English; no jargon about robots or crawlers.

## Sequencing (recommended)

1. **No-index for `/admin`** — small commit, can land first. Sitewide
   robots.txt + admin layout metadata. 30-minute change.
2. **Per-row no-index toggle** — column + UI toggle + reader respect.
3. **SEO settings page** (site-wide) — landing it as a Settings sub-nav
   category ("SEO") once the admin reorg Phase 2 is in.
4. **Auto-fill model picker** — depends on the Models page pattern;
   builds on it.

## Where this fits in the broader plan

The admin reorg Phase 2 (`_plans/2026-06-12-admin-reorg-phase2.md`) ships
**Settings sub-nav: General · Models · Intros & outros**. This plan adds
a fourth sub-nav category: **SEO**. The reorg should land first so SEO
slots into a stable shell.

This plan is its own branch when we get to it.
