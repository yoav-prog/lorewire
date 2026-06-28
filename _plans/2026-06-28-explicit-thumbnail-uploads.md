# Explicit thumbnail uploads to every social platform

Date: 2026-06-28
Owner: Yoav
Status: Draft, awaiting approval (architectural direction already approved 2026-06-28)

## Why this exists

Even after PR #135 fixed the splice so frame 0 of every short is the
story's cold-open scene (not the brand intro), Yoav reported that
posts on the socials still show the wrong thumbnail. Investigation
(via Context7 against each platform's official docs) revealed that
**none** of the 4 publishers (IG, YouTube, TikTok, FB) currently
sends any thumbnail-control parameter — every platform is auto-
picking the thumbnail itself:

- **IG Reels**: picks frame 0 by default. Splice fix already makes
  frame 0 correct, but the publisher doesn't send anything explicit,
  and the auto-pick can be affected by IG's "smart cover" feature.
- **YouTube Shorts**: uses a "suggested" picker that scores frames
  for visual distinctiveness. The brand intro (bright red on dark
  background) is the most distinctive frame in every short, so
  YouTube picks it almost every time — REGARDLESS of where it is in
  the video. The splice fix alone does not help YouTube. Custom
  thumbnail upload is the only reliable fix.
- **TikTok**: defaults to a TikTok-chosen frame. Documented param
  is `video_cover_timestamp_ms` — a timestamp into the video.
- **Facebook Reels / videos**: defaults to an early-frame pick. The
  `/page/videos` endpoint accepts a `thumb` multipart upload for
  custom images.

The hook-first splice (PR #135) was necessary but not sufficient.
This plan adds the explicit thumbnail-control parameter or upload
to every publisher so the cover image is deterministic per story.

## Goals

1. Every published short on every platform shows the story's
   cold-open scene as the cover image — deterministically, not
   subject to a platform's smart-picker.
2. Thumbnail control is best-effort: if a platform's thumbnail API
   fails (channel not verified, image format rejected, transient
   network error), the publish itself still succeeds. The cover
   falls back to the platform's auto-pick. No new failure mode for
   the publish flow.
3. Zero new image generation. The thumbnail source is the existing
   scene-1 image (`short_config.doodle_frames[0].url`) — already in
   GCS, already unique per story, already designed as the cold-open
   visual brief.
4. No new env vars, no new tokens, no new API surfaces beyond what
   the platforms already require for publishing.

## Constraints

- Per-platform mechanism, not a single shared API. Different
  platforms accept different surfaces:
  - **Timestamp-based** (IG Reels, TikTok): pass `0` to pick frame
    0 of the MP4. The splice fix carries the actual content.
  - **Image-upload-based** (YouTube, FB): fetch scene-1's image
    bytes from GCS, upload as multipart. This is the only way to
    override platform smart-pickers.
- Shared helper for the image-upload path: a single
  `resolveShortThumbnailUrl(storyId)` lookup so YouTube + FB read
  from the same source.
- No new tables, no new columns, no new settings. The data the
  publishers need (`story.short_config.doodle_frames[0].url`)
  already exists.
- Per global rule 8 (cost): the change adds one extra HTTP roundtrip
  per publish (the thumbnail fetch + upload). Negligible bandwidth
  (~500 KB per upload) and negligible API cost (IG / FB charge
  nothing; YouTube counts thumbnail uploads under the same quota as
  the video upload itself).

## Chosen approach

Per the council's prior recommendation (Expansionist + First
Principles voices, prior plan): treat the cover as a deliberate
artifact, not a fallback. For now we reuse scene-1 (already a
deliberate, unique-per-story artifact) rather than generating a
dedicated poster — that's a separate Phase 2 plan flagged in
§Open Questions.

### Shared — thumbnail source resolver

New helper `resolveShortThumbnailUrl(storyId)` in
`lorewire-app/src/lib/short-thumbnail.ts`:

1. Load `story.short_config` (already a JSON column on stories).
2. Parse via `parseShortConfig`.
3. Return `config.doodle_frames[0].url` if present, else null.

Callers (FB + YouTube publishers) treat `null` as "no thumbnail
upload; let the platform auto-pick".

### Part 1 — Instagram Reels (1-line param add)

File: `lorewire-app/src/lib/publish-to-instagram.ts:340-385`
(`createContainer`).

The `URLSearchParams` body already carries `media_type=REELS`,
`video_url`, `caption`. Add one line:

```ts
thumb_offset: "0",
```

Per Meta's IG Graph API v22, `thumb_offset` is a string of
milliseconds into the video. Setting `"0"` means "use the very
first frame as the cover". Combined with the splice fix, frame 0
is the story's unique cold-open scene.

No new error paths — the parameter is documented and accepted by
v22. If a future API version deprecates it, IG falls back to its
auto-pick (frame 0), which still works because of the splice.

### Part 2 — TikTok (1-line param add)

File: `lorewire-app/src/lib/publish-to-tiktok.ts` — find the
publish-init call that POSTs to
`/v2/post/publish/{inbox|video}/init/`. The body already carries a
`post_info` object. Add one field:

```ts
post_info: {
  // ... existing fields ...
  video_cover_timestamp_ms: 0,
},
```

Per TikTok's Content Posting API, this picks a specific timestamp
from the uploaded video as the cover. `0` picks the first frame.

Same risk profile as IG: documented param, falls back to auto-pick
if rejected.

### Part 3 — YouTube custom thumbnail (new API call)

File: `lorewire-app/src/lib/publish-to-youtube.ts`.

After the resumable upload finishes and returns the new videoId
(currently around line 600+), add a new step:

1. Call `resolveShortThumbnailUrl(storyId)`. If null, skip Part 3
   entirely.
2. Fetch the URL's bytes via `undici` (the same fetch the rest of
   the publisher uses).
3. POST the bytes as multipart/form-data to
   `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=<id>`
   with the OAuth Bearer token.
4. Expected response: 200 with the new thumbnails JSON.

Error handling — per Context7 docs for `thumbnails.set`:
- **403 forbidden**: channel lacks custom-thumbnail privilege
  (most channels under verification threshold). LOG as a warning
  with the story id and continue; YouTube keeps the auto-pick.
- **429 uploadRateLimitExceeded**: channel hit the thumbnail
  upload quota. LOG and continue.
- **400 invalidImage / mediaBodyRequired**: malformed request.
  LOG and continue — the publish itself already succeeded.
- **404 videoNotFound**: only happens if there's a race between
  upload and thumbnail-set; LOG and continue.

The thumbnail-set step is GATED ON A NEW SETTING
`publisher.youtube.custom_thumbnail_enabled` (default ON), so an
admin can disable it without a code change if YouTube quotas
become a problem.

### Part 4 — Facebook video thumb (new multipart upload)

File: `lorewire-app/src/lib/publish-to-facebook.ts:298-350`
(`postVideo`).

The current call sends `file_url` + `description` as
`application/x-www-form-urlencoded`. To add a thumb, the request
needs to become `multipart/form-data` so we can attach the binary
image. Two steps:

1. Call `resolveShortThumbnailUrl(storyId)`. If null, skip the
   thumb (current behavior).
2. Build a multipart body with the existing fields PLUS a `thumb`
   part carrying the image bytes (fetched from GCS).

Error handling — `thumb` upload failure must not break the publish:
- If the GCS fetch fails: log + retry without `thumb` (revert to
  url-encoded body, current behavior).
- If FB rejects the multipart: log + retry without `thumb`.

Gated on a new setting `publisher.facebook.custom_thumbnail_enabled`
(default ON) for the same reason as YouTube.

## Alternatives rejected

1. **Build a dedicated poster image per story (Phase 2 of the
   earlier council recommendation).** Rejected for v1 because
   scene-1 is the cold-open visual brief per the hook-first plan
   — it's already a deliberate, unique-per-story artifact. The
   dedicated-poster work (hook text overlay, brand mark, designed
   as a 1080x1920 marketing tile) is a separate plan; ship the
   reliability fix first, then upgrade the image asset.

2. **Use the hero image instead of scene-1.** Rejected because
   the hero is designed for the magazine-promotional surface
   (mostly horizontal-brain), not for the vertical 9:16 grid tile.
   Scene-1 is purpose-built for the cold-open moment in the
   right aspect ratio.

3. **Use IG Reels `cover_url` parameter instead of `thumb_offset`.**
   The Meta Graph API v22 docs do mention a `cover_url` for media
   containers in some contexts, but the open-source `instagram-
   graph-api-lib` and the official Reels reference both surface
   only `thumb_offset` (timestamp). The Contrarian council member
   in the prior round explicitly warned that `cover_url` has been
   silently ignored for Reels in past versions. `thumb_offset=0`
   is documented, simple, and matches the splice fix exactly —
   no API risk.

4. **Make every platform use multipart with explicit image.**
   Rejected for IG + TikTok because their documented APIs use
   timestamps, not URLs. Forcing multipart would deviate from the
   platform contract.

5. **Block the publish if the thumbnail upload fails.** Rejected
   because a 403 (channel lacks custom-thumbnail privilege on
   YouTube) is a common steady-state outcome for new channels,
   not a bug. Blocking would stop all YouTube publishes on a
   freshly-onboarded channel. Best-effort with loud logs is the
   right risk profile.

## Open questions

1. **Phase 2: dedicated poster image.** After this lands, evaluate
   whether scene-1 alone reads strongly as a Reels grid tile or
   YouTube Shorts thumbnail. If not, the next plan adds a
   deliberate poster composition (hook text overlay + character
   face + brand mark) generated as a 1080x1920 PNG per story.
   Trigger to start that plan: 2 weeks of CTR / impression data
   on the new thumbnails.

2. **Backfill of existing posts.** This plan only affects
   publishes that fire AFTER the merge. The currently-bad
   thumbnails on already-published posts need:
   - Re-render via the bulk-regen UI (PR #134 already shipped).
   - Delete + republish each post via the existing manual UI in
     each platform's editor. The republish will then use the new
     thumbnail flow.

3. **IG `thumb_offset` units.** Per Meta docs the unit is
   milliseconds; some legacy references list seconds. Verified
   via Context7 against `instagram-graph-api-lib` types: the
   parameter is documented as a `number` representing seconds
   in the unofficial lib but milliseconds in the official docs.
   Going with `"0"` either way — `0ms == 0s == first frame` so
   the ambiguity is harmless for our usage.

## Security

- No new auth surface. The IG / FB / YouTube / TikTok tokens
  already in use carry the permissions needed for thumbnail
  operations on each platform.
- No PII added to logs. The new log lines carry only story id,
  cover-source flag (`scene_1 | none | failed`), and HTTP status
  / latency.
- The thumbnail URL points to a GCS object already publicly
  readable (the same bucket that serves the rendered MP4); no
  new public surface.
- Best-effort thumbnail failure cannot leak data — on failure we
  log + continue, never expose the error message to the
  end-user-facing publish row.

## Observability

Per global rule 14, every behavior change emits namespaced logs:

- `[publish instagram cover] thumb_offset=0` — fires once per
  IG publish so the operator can confirm the param landed.
- `[publish tiktok cover] timestamp_ms=0` — same for TikTok.
- `[publish youtube cover] source=scene_1 video_id=... status=ok|skip|403|429|other` —
  full picture per YouTube publish; the operator can grep `403`
  to find channels needing custom-thumbnail verification.
- `[publish facebook cover] source=scene_1 status=ok|skip|fetch_fail|upload_fail` —
  same for FB.
- Aggregate dashboard: existing `/admin/(panel)/settings/socials`
  log surface already shows per-publish lines; the new fields
  surface there without UI changes.

## Settings

Per global rule 15, the audit:

- `publisher.youtube.custom_thumbnail_enabled` (default ON) —
  admin can flip off if quota becomes a problem or the channel
  consistently 403s. Off = skip the thumbnails.set call entirely;
  YouTube auto-picks.
- `publisher.facebook.custom_thumbnail_enabled` (default ON) —
  same shape. Off = the publish reverts to the legacy
  url-encoded body.
- **Not exposed**: per-story thumbnail picker. The thumbnail
  strategy ("use scene-1") is a brand invariant; making it
  per-story would let it drift and would invite "but my story
  needs a custom cover" requests that we'd just answer with the
  dedicated-poster Phase 2. Resist the knob.

## Testing

Per global rule 18:

### Vitest unit tests (one file per publisher change)

- `lib/short-thumbnail.test.ts` — `resolveShortThumbnailUrl`
  returns the scene-1 URL on a well-formed `short_config`, null
  on missing / empty `short_config`, null on missing
  `doodle_frames`, null on a story that doesn't exist.
- `lib/publish-to-instagram.test.ts` (extend existing) —
  `createContainer` POST body includes `thumb_offset=0`. Existing
  tests stay green (the new param is appended, not replacing).
- `lib/publish-to-tiktok.test.ts` (extend existing) — the publish-
  init body has `post_info.video_cover_timestamp_ms === 0`.
- `lib/publish-to-youtube.test.ts` (extend existing) — after a
  successful upload that returns a videoId, the publisher invokes
  the thumbnail-set step with the resolved scene-1 URL. A 403
  response logs the warning and does not throw. A `null` from
  the resolver skips the call entirely.
- `lib/publish-to-facebook.test.ts` (extend existing) — when
  `resolveShortThumbnailUrl` returns a URL, `postVideo` switches
  to multipart and includes the `thumb` part. When it returns
  null OR the GCS fetch fails, the publisher falls back to the
  current url-encoded path.

### Manual smoke (post-deploy)

For each platform, publish one fresh short, observe the platform's
post:

- **IG**: grid tile shows the cold-open scene, not the brand intro.
- **YouTube Shorts**: thumbnail shows the cold-open scene (verify
  the channel has custom-thumbnail privilege; check the log line).
- **TikTok**: cover shows the cold-open scene.
- **FB**: feed post thumbnail shows the cold-open scene.

### Run

```
pnpm --filter lorewire-app vitest run src/lib/short-thumbnail.test.ts \
  src/lib/publish-to-instagram.test.ts \
  src/lib/publish-to-tiktok.test.ts \
  src/lib/publish-to-youtube.test.ts \
  src/lib/publish-to-facebook.test.ts
```

## Deploy

Per global rule 19 and `lorewire-app/AGENTS.md`:

- **Current state**: production-source is
  `feat/multi-platform-shorts-publisher` at `9501e2a` (the
  hook-first merge tip). `main` is still behind.
- **Branch**: this work lives on
  `feat/explicit-thumbnail-uploads` off `9501e2a`. One PR.
- **Promotion path**: PR targets
  `feat/multi-platform-shorts-publisher`. CI runs the vitest
  files. Merge auto-deploys via Vercel Production Branch tracking.
  Do NOT click any manual Vercel UI promotion buttons.
- **Rollback**: `git revert` of the merge commit on
  `feat/multi-platform-shorts-publisher`. Each new param /
  upload is gated by either a setting (YouTube, FB) or a fixed
  literal value (IG, TikTok), so partial rollback can't put the
  publish into a worse shape than today.
- **Confirm with Yoav before pushing.**

## What this plan does NOT do

- Does not generate a new image. Reuses scene-1.
- Does not change which platforms get auto-published. Same gates
  as today.
- Does not fix already-published posts. Those need re-render +
  manual republish (per Open Question §2).
- Does not change the splice path, the Remotion composition, or
  the render pipeline. Renderer-side work is locked in by PR #135.
