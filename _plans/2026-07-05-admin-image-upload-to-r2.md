# Admin image upload to R2 (2026-07-05)

## Goal

Every admin field where an image URL is typed by hand gets an "Upload image"
option next to it. The file lands in our own storage (R2 in production) and
the field is filled with the resulting public URL, saved automatically where
the surface already autosaves.

## Surfaces (the complete list)

An audit of the admin found exactly three fields where an image URL is
entered manually. Everything else image-shaped in the admin (hero art,
thumbnails, scene frames, posters) is pipeline-generated or already has an
upload path (article body images, gallery images via
`/api/admin/articles/images`).

1. **SEO settings → Default OG image** (`seo.default_og_image`)
2. **SEO settings → Organization logo URL** (`seo.organization_logo_url`)
3. **Article editor → Social card image (OG)** (per-article `og_image`)

## Approach

- **One new endpoint**: `POST /api/admin/uploads/image`, multipart
  `file` + `slot` (+ `articleId` for the article slot). Slots are a closed
  enum so a tampered client can't write arbitrary keys:
  - `seo-og-default` → `site/seo/og-default-<hash>.<ext>`
  - `seo-org-logo`   → `site/seo/org-logo-<hash>.<ext>`
  - `article-og`     → `articles/<articleId>/og-<hash>.<ext>`
- **Storage**: `uploadBuffer` in `lib/gcs.ts` already routes to R2
  (media bucket + `MEDIA_PUBLIC_BASE` URL) when `isR2MediaActive()`, falling
  back to GCS otherwise — production is on R2, so uploads land in R2 with the
  immutable cache header. We add a `compress: false` opt-out because
  `uploadBuffer` force-re-encodes PNG/JPG to WebP, and WebP is unsafe for
  OG/social images (LinkedIn and WhatsApp crawlers don't render it). OG and
  logo uploads keep their original PNG/JPG bytes.
- **Keys are content-addressed** (sha256 prefix) so replacing the image
  busts caches naturally under `Cache-Control: immutable`, and identical
  re-uploads dedupe.
- **UI**:
  - New `SettingImageField` client control on the SEO page (matches the
    `SettingText` autosave pattern: debounced save + AutoSaveStatus pill)
    with an Upload button, URL input, and a live preview. After a successful
    upload the URL is filled AND saved — one click does everything.
  - `ArticleSeoPanel` gets an Upload button on the OG field. It fills the
    field + preview only; the panel deliberately has no autosave (slug
    allocation), so the writer still clicks "Save SEO".

## Alternatives rejected

- **Presigned direct-to-R2 browser PUT** (like the segments uploader):
  needed only for >4.5 MB bodies. Social images are ≤4 MB by rule; the
  single round trip is simpler and matches the article images route.
- **Reusing `/api/admin/articles/images` with a nullable articleId**: that
  route's contract (article existence check, GIF acceptance, WebP
  compression) is right for body images and wrong for brand/OG assets.
  Separate route, shared validation lib.
- **Storing bytes in the DB / a new bucket**: media bucket + `site/` prefix
  is already public, cached, and backed up by the same lifecycle as the rest
  of the editorial media.

## Security

- Route requires `content.manage` (same capability that gates
  `saveSettingAction` and the existing article image upload).
- Closed slot enum → no client-controlled key paths.
- 4 MB cap (fits Vercel's 4.5 MB function body limit with envelope room).
- Magic-byte sniffing (PNG/JPEG/WebP only for these slots; browser MIME is
  advisory). Bytes are stored as-is — no SVG, no HTML, image/* content type
  only, served from the media origin, not the app origin.
- `article-og` verifies the article exists before writing.

## Observability

- `[admin image-upload]` namespace on the server route (ok/reject/store
  failure with slot, bytes, mime, key) and in the two client surfaces
  (picked file, response status, resulting URL).

## Settings audit

The feature *is* a settings-surface upgrade; no new knobs. Intentionally not
exposed: bucket/prefix choice (deploy concern, env-driven), compression
toggle (correctness concern, not preference).

## Testing

- `lib/admin-image-upload.test.ts`: mime sniffing (PNG/JPEG/WebP/GIF magic
  bytes, truncated, garbage), slot key building (shape, hash stability,
  articleId requirement, unknown slot rejection), extension mapping.
- `lib/gcs.test.ts` gains coverage that `compress: false` skips the WebP
  re-encode.
- Full `vitest run` green before commit.

## Deploy

- Branch `feat/admin-image-uploads-r2` off main → PR into main → normal
  Vercel pipeline. No env changes: reuses `R2_*` + `MEDIA_PUBLIC_BASE`
  already live in production. Rollback = revert the PR; uploaded objects are
  inert files.
