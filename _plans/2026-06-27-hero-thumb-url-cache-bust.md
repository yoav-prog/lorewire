# Hero / Thumbnail URL Cache-Bust

**Date:** 2026-06-27
**Status:** approved, in progress
**Owner:** Yoav + Claude

## Goal

Stop hero/thumbnail regenerations from being masked by stale browser/CDN/Vercel-image-opt caches on the public homepage. After this change, every regen produces a unique URL even though the underlying R2/GCS object key stays the same.

## Problem (observed 2026-06-27)

On the public homepage's TOP 10 rail, regenerating one short's hero+thumbnail visibly flipped a *different* short's poster to what looked like an older version. Diagnostic in `scripts/diag_hero_regen_cross_writes.mjs` (already run) confirmed:

- No story-jobs finisher or refresh-assets state machine was firing in the background.
- No stale `image_renders` rows were being drained.
- Each regen wrote ONLY to its own `story_id` — no cross-story DB writes exist.

Root cause: hero/thumbnail filenames are hardcoded per variant in `pipeline/media.py:_HERO_THUMB_VARIANTS` (`hero.png`, `hero-landscape.png`, `thumbnail.png`, `thumbnail-landscape.png`, `thumbnail-square.png`). Every regen uploads to the SAME R2 object key (`{story_id}/hero.png`), overwriting in place. The URL stored in `stories.hero_image` is byte-for-byte identical across regens. Browser cache, Vercel Image Optimizer, and Cloudflare/edge cache all key on the URL — same URL means same cache entry — so they keep serving the previous bytes until TTL expiry. Different cache layers evict on different clocks, which is what produced the "regen A reverts B" illusion: the user was actually seeing a random sample of cached versions across layers each time the homepage re-rendered.

## Fix

Append a `?v={epoch_seconds}` query-string version to the URL **at the point the regen helper would write it to the DB column**. The R2 object key is unchanged — R2/GCS lookups ignore query strings, so the file at the deterministic key still serves. Every layer in front of R2 (Vercel Image Opt, browser cache, edge cache) keys on the full URL including query, so `?v=1719440000` is a brand-new cache entry vs. `?v=1719439000`.

### Why query param, not a versioned filename

Versioned filenames (`hero-{ts}.png`) would force a stale-file-cleanup chore and break the resume-skip optimization in `_build_hero_and_thumbnail_from_short` (which reads the existing column value to decide which variants to skip on a reclaim — checks truthiness, not URL shape, so query params are fine but a different filename would confuse the resume path's "did we already write this variant" check). Query-param busts give us cache invalidation without changing the object key.

### Scope

Touches the regen paths only — NOT the fresh-run pipeline. Fresh stories don't have a cached version yet (URL never existed), so cache-busting is a no-op for them. If the same caching problem surfaces for scenes/props/voice later, expand the helper there.

Patched call sites in `pipeline/media.py`:

1. `_regen_hero` — portrait write (line ~1186)
2. `_regen_hero` — landscape write (line ~1240)
3. `_regen_hero_from_short` — portrait write (line ~1392)
4. `_regen_hero_from_short` — landscape write (line ~1452)
5. `_build_hero_and_thumbnail_from_short` — variant loop write (line ~1786)

## Alternatives rejected

- **Lower R2/CDN cache headers + `unoptimized` Next.js Image:** slower for everyone, doesn't fix browser-cache, costs more bandwidth, treats a symptom not the cause.
- **Versioned filenames (`hero-{ts}.png`):** requires a stale-file cleanup job, increases storage churn, and the deterministic-path resume-skip pattern would have to learn the new naming.
- **Manual cache purge after every regen:** more moving parts (purge API, retries, race with cache warming), zero benefit over query-bust.

## Observability

- Add a one-line log per write so the bust timestamp is visible in Vercel logs.
- The existing `image_saved` render-event payload already carries the URL — the busted URL will surface there naturally, no schema change needed.

## Security

- The cache-bust value is a Unix timestamp, not sensitive data.
- No new attack surface: query strings on public image URLs are inert.
- No PII in the URL.

## Settings

- No new setting. Behavior is unconditional; reverting to the old behavior would just bring the bug back.

## Testing

- Unit: new `test_hero_regen_url_has_cache_bust` in `pipeline/tests/test_media_regen.py` verifying the URL written to the column has `?v={int}` appended (mocked `time.time`, deterministic check).
- Unit: update `test_hero_uploads_through_gcs_publish` to assert the column write equals `<publish_url>?v=<ts>` instead of just `<publish_url>`.
- Run: `python -m pytest pipeline/tests/test_media_regen.py pipeline/tests/test_hero_thumbnail_from_short.py -v` — both must stay green.

## Deploy

- This change ships through the normal `main` merge → Vercel auto-deploy flow.
- No DB migration needed.
- Existing URLs in the DB without the version param stay as-is; the next regen of any story stamps the new version onto its columns. No backfill required.
- Rollback: revert the commit; old behavior returns. No data shape changed.
