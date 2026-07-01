# Facebook Reel custom cover via post-publish thumbnails edge

Date: 2026-07-01
Status: implemented, pending live verification on one publish

## Goal

Give published Facebook shorts a deliberate cover (the LoreWire poster)
instead of Facebook's auto-picked frame, the same way Instagram Reels
already get one via `cover_url`.

## Context / findings (verified online 2026-07-01)

- Our shorts are 9:16, so Facebook auto-converts them to **Reels** on
  publish (the "LoreWire's Reels" shelf).
- The `thumb` field on the legacy `POST /{page-id}/videos` upload is
  ignored when the video is supplied via `file_url` (hosted pull), which
  is how we upload. So the cover we were attaching never applied.
- The dedicated `POST /{page-id}/video_reels` endpoint exposes **no**
  cover/thumbnail parameter at all (checked the v25 Graph API reference).
  This is the gap vs Instagram, whose `/media` container accepts
  `cover_url` + `thumb_offset` (why IG covers work for us).
- The one remaining lever is `POST /{video-id}/thumbnails` with
  `source` (image) + `is_preferred=true`, applied AFTER publish using the
  returned video id.

## Decision

Replace the dead `/videos` `thumb` multipart with a best-effort
post-publish `POST /{video-id}/thumbnails` call:

- `postVideo` goes back to the simple url-encoded body (no multipart).
- New `setVideoThumbnail()` fetches the poster bytes (via the shared
  `fetchPosterBytes`, R2-direct in prod) and POSTs them to the video's
  `/thumbnails` edge with `is_preferred=true`.
- New `maybeSetVideoThumbnail()` gates on the existing
  `publisher.facebook.upload_custom_thumbnail` setting + a resolved
  poster URL, logs `custom_thumbnail_{ok,failed,skipped}` (matching the
  YT publisher), and NEVER throws or reverts the `posted` row.
- Wired into both the fresh-publish and retry paths.

## Alternatives rejected

- **Keep `/videos` thumb AND add the post-publish call.** Rejected: the
  thumb is confirmed dead for Reels, so it would just fetch the poster
  bytes twice per publish for nothing.
- **Switch to `/video_reels`.** Rejected: no cover parameter, so it
  cannot help the cover, and it's a bigger rewrite of a working path.
- **Bake the poster into frame 0 of the MP4.** Kept as the fallback if
  the thumbnails edge is ignored on Reels (Facebook's auto-cover tends to
  grab an early frame). Not done yet; revisit only if the edge fails.

## Honest expectation

Meta's docs do not confirm `/{video-id}/thumbnails` applies to Reels.
Like YouTube Shorts, the in-feed Reels player may keep showing a frame;
if it works at all, it is most likely on the Page's Reels grid / search.
This is an experiment: publish one story, check the grid, read the
`[publish facebook custom_thumbnail_*]` log line, and keep or disable.

## Security / safety

No new secret or surface. Same `FB_PAGE_ACCESS_TOKEN`, same best-effort
contract (a cover failure can never fail or revert a live publish). Token
still never logged (only `custom_thumbnail_*` events with host/status).

## QA

- Unit tests updated in `publish-to-facebook.test.ts`: happy path (3
  calls: publish, bytes GET, thumbnails POST), thumbnails-edge 403 stays
  `posted`, poster-bytes-unavailable stays `posted` with no thumbnails
  POST, setting-off and no-short_config skip the cover step.
- Live: one Facebook publish, confirm the grid cover + the ok/failed log.
