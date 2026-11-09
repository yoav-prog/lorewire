# SEO PR 3: built-in brand assets (default OG image + organization logo)

Date: 2026-07-05
Branch: `seo/brand-assets` off `main` (post #223/#225 merge).
Trigger: production audit after the SEO passes went live — homepage shares have
no preview image (seo.default_og_image empty) and the Organization JSON-LD has
no logo (seo.organization_logo_url empty). The admin fields exist; the assets don't.

## Goals

Ship brand assets WITH the app so shares and the knowledge panel work with zero
admin action, while the admin fields keep overriding when set. Lazy-user rule:
the right default beats a field someone has to remember to fill.

## What ships

1. `public/og.png` (1200x630) — dark-editorial share card: LW badge, LORE/WIRE
   wordmark (Archivo Black, ink + accent), tagline in Hanken Grotesk, giant
   low-opacity glyph echoing the PosterArt fallback treatment. Brand palette
   (#0A0A0C / #F5F3EF / #E8462B), not a generic gradient.
2. `public/logo.png` (1024x1024) — the LW badge as a square mark for the
   Organization JSON-LD (Google wants >= 600x600).
3. `scripts/gen_brand_assets.mjs` — committed generator (opentype.js text ->
   SVG paths -> sharp PNG) so the assets are reproducible; fonts fetched from
   the google/fonts repo at run time; run with `npm i --no-save opentype.js`.
   Text is rendered as outlines, so no font install is needed on any machine.
4. Fallback wiring (admin values always win):
   - Homepage og/twitter image: seo.default_og_image, else `{origin}/og.png`.
   - Organization JSON-LD logo: seo.organization_logo_url, else `{origin}/logo.png`.
   - Organization sameAs default: ["https://www.youtube.com/@LoreWireHQ"] (the
     canonical channel URL already baked into the YouTube publisher copy).
   - New `fallbackBrandAsset()` helper in site-seo.ts, unit-tested.
5. Admin hints updated so the fields say a built-in default ships at /og.png
   and /logo.png.

## Not in scope (only Yoav can supply)

Google/Bing verification tokens; TikTok/Instagram/Facebook profile URLs for
sameAs (publisher stores API ids, not public URLs).

## Security / Observability / Settings

Static assets + fallback URLs only; no new inputs, no logging surface. Settings:
no new fields — this PR makes two existing fields optional-by-default.

## Testing

fallbackBrandAsset unit tests (explicit wins, origin-relative fallback, no-origin
-> undefined); buildSiteJsonLd logo fallback + sameAs default tests; full suite;
next build; curl /og.png + /logo.png on the built app; visual review of both PNGs.

## Deploy

Standard: branch -> PR -> preview -> merge to main deploys. Rollback: revert.
