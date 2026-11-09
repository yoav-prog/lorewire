# SEO PR 1: crawlability + metadata fixes

Date: 2026-07-05
Branch: `seo/crawlability-and-metadata` off `main` (589e0d7)
Trigger: external SEO/GEO audit (Chrome extension crawl) verified against the codebase
by two exploration passes. Google indexes exactly one URL (the homepage) because no
crawlable link path exists from the homepage to any story page.

## Goals

Make the site crawlable and fix the metadata layer so the 60+ published story pages
can be discovered and indexed by search engines and AI crawlers. This PR is the
"80% of value" slice; structured data (VideoObject/FAQPage/Organization JSON-LD,
visible publish dates) is PR 2; nav-as-routes is a separate product decision.

## Verified findings this PR fixes

1. Story cards, hero CTAs, and Top 10 cards are `<button onClick>` elements that
   open a modal without changing the URL (AppShell.tsx 532/535/610/883, DesktopShell.tsx
   547/548/623/707). Crawlers have zero paths to `/v/{slug}`.
2. Double-brand titles: pages build "Title · LoreWire" via `buildPageTitle()` AND the
   root layout applies `title.template: "%s · LoreWire"` on top -> "Title · LoreWire ·
   LoreWire". Verified against the bundled Next 16 docs: a parent `title.template`
   applies to any child page string title. Affects /v, /u, /c, /c/articles, /articles
   readers, and /settings (hardcoded "Settings · LoreWire").
3. Homepage has no generateMetadata: no canonical, no Open Graph, no Twitter card,
   title is bare "LoreWire". Root layout has no `metadataBase`.
4. robots.ts lacks the `Sitemap:` declaration.
5. sitemap.ts omits static pages (about/faq/privacy/terms/dmca/community-guidelines)
   and the /c/{category} pages (which exist and render but are orphaned).
6. /settings is indexable (no robots noindex).
7. Homepage has no h1 in either shell (MobileHeroTitleH1 and HeroTitleH1 both exist
   but are unused since the 2026-06-26 redesign demoted hero titles to h2).
8. All homepage/card images ship `alt=""` (AppShell 184/429, DesktopShell 186/444).
9. Hero image is a plain lazy `<img>` with no fetchpriority -> LCP 7.7s on mobile PSI.

## Approach

### Crawlable links (the core fix)
- New server-safe helper `src/lib/story-path.ts`: `storyReaderPath(story) -> "/v/{slug}" | null`
  (null when the story has no slug, i.e. seed/sample stories).
- PosterCard (both shells), Top 10 cards (both shells), and hero CTAs render a real
  `<a href={storyReaderPath(story)}>` when the slug exists, keeping the existing
  onClick with `e.preventDefault()` so the modal UX is unchanged (standard
  progressive-enhancement pattern). No slug -> keep the current `<button>`.
- Both shells mount in the same HTML (CSS shows one), so the crawler sees links twice;
  that is fine (same hrefs, standard responsive pattern).

### Titles
- Pages stop pre-branding: pass the bare page title and let the root layout's
  `title.template` append the brand exactly once.
- `buildPageTitle` usages in /v, /u, /c, /c/articles, /articles readers switch to bare
  strings; /settings drops the hardcoded suffix.
- Root layout keeps `title: { default, template }`, sanitizing a template missing "%s"
  (buildPageTitle's defensive fallback moves there since it is now the single title
  authority). `buildPageTitle` is removed once call sites are gone.

### Homepage metadata + h1
- `generateMetadata` on app/page.tsx: keyworded title via `title.absolute` (admin-
  configurable, new `seo.home_title` setting with a sane default), description from
  seo settings, canonical "/", full openGraph + twitter set, og:site_name.
- `metadataBase` in the root layout from seo.site_url / NEXT_PUBLIC_SITE_ORIGIN
  (guarded: only set when the origin is non-empty; `new URL("")` throws).
- Single visually-hidden `<h1>` rendered server-side in app/page.tsx (NOT inside the
  shells, which would emit two h1s since both mount).

### robots + sitemap + noindex
- robots.ts declares `sitemap: {origin}/sitemap.xml` (needs the origin, so it reads
  getSiteSeo like sitemap.ts already does).
- sitemap.ts adds the six static pages and active category pages (/c/{slug} for
  categories with status='active'). Extract a pure `buildSitemapEntries()` so it is
  unit-testable without a DB.
- /settings metadata gains `robots: { index: false, follow: true }`.

### Images
- PosterArt (both shells) + billboard/hero images: `alt` derived from story title
  (e.g. `story.title`); decorative overlays stay `alt=""`.
- Billboard/Hero LCP image: `loading="eager"` + `fetchPriority="high"` on the ACTIVE
  slide only (neighbors keep the manual preload). No next/image migration in this PR
  (the codebase deliberately uses plain img; a migration is its own piece of work).

## Rejected alternatives

- Converting the whole tab nav to URL routes: real UX/architecture change (back
  button, refresh semantics for Wires/Saved). Deferred to its own decision.
- next/image migration for LCP: bigger blast radius (remote loader config for the
  media domain, sizing audit across every card). eager+fetchpriority gets the LCP win
  now; migration can be evaluated separately.
- `?story=X` links on cards (the existing deep-link): would concentrate all link
  equity on the homepage URL with query params instead of the canonical /v/ pages.

## Security

No new inputs, no auth changes, no secrets. Slug values come from our own DB and are
path-joined client-side into hrefs; slugs are pipeline-generated kebab-case (same
values already used by sitemap.ts and /v routing). noindex on /settings reduces
exposure of a user-facing utility page. robots.txt continues to disallow /admin and /api.

## Observability

- sitemap.ts keeps its `[sitemap] generated` log; extended with static/category counts.
- Card link clicks keep the existing onOpen path (modal open logs unchanged).
- `[home render]` log unchanged. No new client logs needed: markup-only changes.

## Settings audit

- New: `seo.home_title` (Settings -> SEO in admin), default
  "LoreWire · True Internet Stories, Animated & Voted On". Homepage og/description
  reuse existing `seo.default_meta_description` and `seo.default_og_image`.
- Not exposed: alt-text derivation, fetchpriority, sitemap membership of static pages
  (no realistic user need; would be knob clutter).

## Testing

- vitest (existing). New/updated:
  - `story-path.test.ts`: slug -> /v/ path, null/empty slug -> null.
  - `sitemap` pure builder: includes homepage, static pages, active categories,
    stories/articles; honors noindex/expiry filters (regression-fail on old code).
  - robots builder: emits the sitemap URL from settings origin.
  - site-seo: home_title parsing + layout title-template sanitization
    (template without "%s" falls back).
- Full `npm test` run must be green before the PR opens.
- Manual QA: `next build` + inspect emitted HTML for: single h1, real hrefs on cards,
  single-brand titles, robots.txt sitemap line, sitemap entries, /settings noindex.

## Deploy

- Flow (verified): PRs merge to main; Vercel auto-deploys main to production.
- This PR: push branch -> Vercel preview -> review -> merge to main after approval.
  Nothing is pushed or merged without explicit go-ahead (standing rule). No env var
  changes needed. Rollback: revert the merge commit.
- Post-merge follow-ups for Yoav (not code): submit sitemap in Google Search Console
  + Bing Webmaster Tools (no verification tags found in code; the seo.google_verification
  and seo.bing_verification settings already exist in admin and render when set).

## Out of scope (PR 2 and later)

- VideoObject/FAQPage/Organization+WebSite JSON-LD; visible publish date + byline on
  story pages (needs a date plumbed into the Story payload).
- Nav tabs as real routes; /articles publish-or-noindex decision; LCP image
  resizing/compression in the media pipeline; llms.txt.
