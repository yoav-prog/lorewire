# Media compression — shrink every image and video, keep quality

- Date: 2026-06-22
- Branch: `feat/r2-media-migration` (continues the R2 work)
- Status: PLAN + in progress
- Owner: Yoav

## Goal

Media loads slowly because the files are huge — a single doodle scene frame is a
**2.68 MB lossless PNG**, and a short pulls 6-15 of them (20-40 MB per short).
Compress every image and video, keeping visual quality, so files shrink ~10-20×
(images) and ~50% (video). This fixes load speed, storage, and egress at once.

This applies to **new media in the creation flow AND all existing media**.

## Why it's slow (measured, not guessed)

`media.lorewire.com` edge caching works (second fetch = `Cf-Cache-Status: HIT`).
The slowness is purely transfer size: 2.68 MB per PNG frame. So the fix is
compression, not CDN/cache changes.

## Tools — open source, self-hosted, already in the stack

No new external or paid service.

- **Images → Pillow (Python pipeline) / sharp (Node app).** Encode to **WebP**.
  For flat-color doodle art, a 2.68 MB PNG becomes ~150-300 KB WebP at visually
  identical quality (q82-85 is near-lossless for line art). sharp already powers
  avatar upload; Pillow is the Python equivalent (native libwebp).
  AVIF is 20-50% smaller still but encodes 5-7× slower — deferred to hero/
  thumbnail images later; **WebP across the board to start** (universal support,
  one format, the biggest single win).
- **Video → ffmpeg (already renders the shorts).** Re-encode H.264 (libx264)
  **CRF 23**, preset `slow` — 50-70% smaller, no visible quality loss, plays
  everywhere. AV1/VP9 are smaller but far slower and overkill for a reels feed.

## Quality settings (locked)

- Images: WebP `quality=82`, `method=6` (best compression effort). Near-lossless
  for doodles; the source PNGs are line art, not photos.
- Video: H.264 `-crf 23 -preset slow -pix_fmt yuv420p`, audio `aac -b:a 128k`.

## New media (the creation flow)

Centralize so every call site benefits with no per-site edits:

1. **Pipeline images** — `pipeline/gcs.py` `upload()` re-encodes any `.png/.jpg`
   to WebP before upload and returns the `.webp` URL. All of `media.py`,
   `images.py`, `article_media.py` write through `publish()`/`upload()`, so they
   all get WebP for free, and the DB stores `.webp` URLs automatically. [DONE in
   increment 1]
2. **Node images** — `lib/gcs.ts` `uploadBuffer()` re-encodes images to WebP via
   sharp (article CMS images). Avatars already go through sharp.
3. **Video render** — the short render's final ffmpeg encode uses the CRF
   settings above.

## Existing media (the backfill — the current-slowness fix)

Two runners, split by where the codec lives:

1. **Images → admin backfill tool** (`/admin/compress`, like the migration tool):
   iterate the DB rows, and for every referenced **image** URL (hero_image,
   `images[]`, `short_renders.props` frames, article hero/og/document, payload):
   download from R2, re-encode to WebP via sharp, upload to the same key with a
   `.webp` extension, then **rewrite that URL in the DB** to the `.webp` version.
   Batched/resumable/idempotent like the migration. Skips already-`.webp`.
   - Why a DB rewrite: the key extension changes `.png → .webp`, so every
     reference must be updated or the read resolver would 404 the old `.png`.
   - GCS stays the cold backup; the original PNGs are left in place.
2. **Video → CLI/pipeline** (`pipeline/compress_videos.py`): ffmpeg needs a real
   binary, which the Vercel admin runtime doesn't have, so video re-encode runs
   in the pipeline env. Re-encode each `.mp4` in place (same key, no DB change).

## Caveats / decisions

- Image keys change `.png → .webp`; the backfill's DB rewrite is the load-bearing
  step. Build + test it hard.
- Double compression (WebP frames feeding the ffmpeg video) is fine at q82-85 for
  line art — but the render reads the local source PNGs, so the video is encoded
  from the originals; only the *served* frame images become WebP.
- Dev (no GCS/R2) keeps serving local PNGs; compression happens on the upload
  path, so prod gets WebP, dev is unchanged.

## Sequence

1. New-media pipeline images → WebP (centralized in `gcs.py`). [increment 1]
2. Existing-media image backfill admin tool (the current-pain fix). [next]
3. Video: render CRF settings (new) + `compress_videos.py` (existing).
4. Node `uploadBuffer` images → WebP.
5. Later: AVIF for hero/thumbnails.

## Security / cost

All tooling is open-source and runs in our own environments (Pillow, sharp,
ffmpeg). No external service, no per-image fees. R2 storage drops as files
shrink; egress drops too.
