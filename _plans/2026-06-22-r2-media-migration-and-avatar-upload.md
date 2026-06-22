# R2 media migration + user avatar upload

- Date: 2026-06-22
- Branch at time of writing: `feat/multi-platform-shorts-publisher`
- Status: PLAN — pressure-tested by LLM Council (2026-06-22), not yet implemented
- Owner: Yoav

## Goal

Stop paying Google Cloud Storage internet egress on every video view, and add a real
user-avatar upload feature, without breaking existing media links or opening the
platform's first user-generated-content surface to abuse.

Two outcomes:

1. Viewer-facing media is delivered from Cloudflare R2 behind a custom domain with
   edge caching. Egress cost goes to roughly zero and playback gets faster, with the
   exact same video quality (R2 serves the identical MP4 bytes the pipeline renders).
2. Signed-in users can upload a profile picture (today the account page only accepts a
   pasted URL; the input is labelled "Upload coming later").

## Background — how storage works today (verified in code)

- One public GCS bucket (`GCS_BUCKET`), objects uploaded `predefinedAcl=publicRead`,
  keyed `<storyId>/<file>` (e.g. `<id>/video.mp4`, `<id>/voice.mp3`, `<id>/hero.png`).
  Short renders use the `<id>-short/video.mp4` suffix.
- Two writers: the Python pipeline (`pipeline/gcs.py`) for rendered output, and the
  Next app (`lorewire-app/src/lib/gcs.ts`) for browser direct-uploads of raw segment
  sources + article CMS images.
- The reels player sets `<video src>` straight at the public GCS URL
  (`src/components/reels/ReelCard.tsx`) — no CDN, no caching, so every view, replay and
  scroll-past is a full-price egress pull.
- Absolute `https://storage.googleapis.com/<bucket>/<key>` URLs are persisted across DB
  rows (`video_url`, `source_url`, hero images, `users.picture_url`, etc.).
- Avatars are NOT stored by us today: `users.picture_url` holds an external URL only
  (Google/Reddit OAuth picture, DiceBear preset SVG hotlink, or pasted URL). There is
  no upload endpoint anywhere in the repo (confirmed across all branches).

## Decision and the alternatives we rejected

**Chosen: migrate viewer-facing media to Cloudflare R2 behind a custom domain.**

Verified pricing (June 2026):

| Option | Per-GB delivered | Notes |
|---|---|---|
| GCS direct (today) | $0.12 (1st TB) | no caching, every view full price |
| Google Cloud CDN → GCS | ~$0.08/GiB + ~$18/mo LB | ~25-30% off, still pay-per-GB |
| Cloudflare R2 | $0.00 egress | $0.015/GB/mo storage, ops billed (see Cost) |
| Cloudflare Stream | $1 / 1000 min delivered | includes adaptive bitrate |

- **Rejected — keep GCS, add Cloudflare CDN in front.** This is the literal "Cloudflare
  in the middle" idea and it is the one option against Cloudflare's ToS: serving video
  over their CDN is only allowed when the bytes are hosted on a Cloudflare service
  (Stream, Images, R2). A GCS-hosted MP4 proxied through Cloudflare is prohibited, and
  it would still pay GCS egress on every cache fill. Verified via Cloudflare's updated
  ToS / "Delivering Videos with Cloudflare" docs, 2026-06-22.
- **Rejected — Google Cloud CDN in front of GCS.** Legitimate and zero-migration, but
  only ~25-30% cheaper and still scales per-GB with traffic. The migration to R2 is a
  few hours of bounded work and we are touching this code anyway (avatars + URL
  indirection), so the bigger, flat win is worth it.
- **Rejected (for now) — Cloudflare Stream.** Council-confirmed overkill for 40-60s
  clips capped at ~20MB. ABR buys little, and it means re-architecting both the upload
  path (TUS) and the playback path (HLS/signed URLs). Revisit ONLY if real telemetry
  shows mobile rebuffering, or if/when we let users upload video (then Stream's
  transcode pipeline, not its ABR, is the reason).

## What the council changed about the original plan

The council validated R2-over-Stream and the trust-zone bucket split, but corrected the
sequencing and flagged the original plan as not-yet-shippable on two fronts (avatar
security, cutover safety). Key changes folded in below:

1. The FIRST deliverable is URL indirection (store keys, resolve host at read time), not
   the migration. It de-risks the whole cutover and is independently valuable.
2. Cutover is dual-read, and dual-read must outlive the one-time copy by a full render
   cycle (in-flight renders write absolute URLs mid-copy).
3. Avatar upload is a security feature first: per-user rate limit + quota, pixel cap
   BEFORE decode (decompression bombs), orphan reaper for GDPR deletion, abuse-report
   path. Re-encode-to-WebP alone is necessary but not sufficient.
4. Steady-state cost depends on the edge cache: without correct immutable cache headers,
   every view becomes a Class B origin read and recreates the cost problem. Cache-hit
   path is load-bearing.
5. Buckets named by trust zone, not `-prod` suffix.
6. Keep GCS as a cold backup for several weeks; R2 free path has no cross-region
   replication, so a bad delete on public media is otherwise unrecoverable.

## Bucket topology (named by trust zone)

| Bucket | Trust / access | Holds | Delivery |
|---|---|---|---|
| `lorewire-media-prod` | Trusted, public | Editorial/pipeline media: short + long video, audio, hero/scene/article images, thumbnails | Custom domain `media.lorewire.com`, edge-cached, long immutable `Cache-Control` |
| `lorewire-ingest-prod` | Trusted-internal, private | Raw admin segment source uploads + pre-normalization intermediates | S3 API + presigned only, NO custom domain. 30-day lifecycle expiry on raw sources |
| `lorewire-usercontent-prod` | UNTRUSTED, public, isolated | User-uploaded avatars (and future user assets) | Separate origin `usercontent.lorewire.com` so a malicious file can't script the main site |

Notes:
- Public access in R2 = bind a custom domain (whole bucket public, CDN-cached). You
  cannot expose just one prefix, which is why public vs private vs untrusted must be
  separate buckets, not folders.
- Do NOT use the `r2.dev` URL for production (rate-limited, not for prod).
- Do NOT split video and images into separate buckets — same cache policy, no benefit.
- Per-environment siblings (`-staging`) added only when a deployed non-prod env points at
  R2. Dev currently runs on local `/generated/` files and needs no bucket.

## Load-bearing principle: URL indirection (build this first)

Today the DB stores absolute `storage.googleapis.com` URLs. Change to: store the object
key, resolve the delivery host at read time.

- New helper `mediaUrl(key)` (Node) + Python equivalent: prepends the configured public
  base (`MEDIA_PUBLIC_BASE`, e.g. `https://media.lorewire.com`).
- Dual-read shim: a function that takes any stored value and returns a live URL. If the
  value is already an absolute legacy GCS URL, rewrite its host to the new base; if it's
  a bare key, prepend the base. This makes old rows and new rows both resolve correctly
  during and after cutover.
- Update `parseGcsUrl` / host checks / delete path (`gcs.ts`) to key off the configured
  bucket(s), not a hard-coded `storage.googleapis.com`.
- The short-detection regex (`short-video-url.ts`) keys on the object suffix, not the
  host, so it survives unchanged.

## Migration / cutover sequence (safe order)

1. Create the three buckets, Standard storage class. Bind `media.lorewire.com` to the
   media bucket and `usercontent.lorewire.com` to the user-content bucket. Configure R2
   CORS on `ingest` (browser-direct segment PUTs) and on `usercontent` if any direct
   browser interaction is added later.
2. Ship URL indirection + dual-read (above). Deploy. Nothing else has changed yet;
   everything still resolves to GCS via the rewrite. This is the de-risking step.
3. One-time copy GCS → R2 with `rclone` (keys identical). Price the Class A write storm
   (see Cost). This is a backfill; reads still work via dual-read against either host.
4. Flip both writers (`gcs.py`, `gcs.ts`) to the R2 S3 API (`@aws-sdk/client-s3` /
   boto3). New renders land in R2. Set long immutable `Cache-Control` on write.
5. Backfill-rewrite DB rows from absolute GCS URLs to keys (script). Keep dual-read as
   the safety net — do not remove it in the same deploy.
6. Soak for at least one full render cycle plus a margin (weeks). Keep GCS intact as a
   cold backup. Monitor 404s / cache-hit ratio.
7. Only then, decommission GCS writes; keep the GCS bucket as cold backup until we're
   confident (then downgrade to Archive class or delete).

In-flight renders finish against whatever host they started with because dual-read
covers both. Existing `?v=token` cache-bust query params survive a host swap untouched.

## Avatar upload feature (the new build)

Flow (lazy-user, rule 10):

- Account page: replace the "paste a URL" box with an "Upload photo" control. On mobile
  one tap opens the camera roll or take-a-selfie; on desktop, file picker + drag-drop.
- Client: immediate local preview, square/circle auto-crop UI, downscale before upload.
- Server route `POST /api/user/avatar`: small files (<~4.5 MB) POST straight through the
  serverless function so we validate and re-encode BEFORE anything becomes public (no
  presigned direct-to-bucket for avatars).
- Server validates, re-encodes to WebP, writes to `lorewire-usercontent-prod` at
  `avatars/<userId>-<contentHash>.webp`, writes the resolved URL into the existing
  `users.picture_url` column (no schema change), and deletes the previous object.

Security (this is the gate, not a polish pass):

- Allowlist input types jpeg/png/webp by sniffing magic bytes, not the declared
  `Content-Type` (defeats content-type spoofing).
- Re-encode every upload through Sharp to WebP. Set `limitInputPixels` and cap decoded
  dimensions BEFORE decode (decompression-bomb defense — a tiny file can expand to GBs).
  Strip all metadata/EXIF on re-encode.
- NEVER store or serve SVG. An SVG can carry script; served from our origin that's XSS.
- Serve from the isolated `usercontent.lorewire.com` origin so even a slipped-through
  file cannot script the main site.
- Per-user rate limit AND a hard per-user object quota (e.g. 1 current avatar; replacing
  deletes the old). Without this the public bucket is free abuse/CSAM hosting with legal
  exposure.
- Orphan reaper: replacing or deleting an avatar must delete the old object; a periodic
  sweep reconciles `usercontent` objects against live `users.picture_url` so GDPR
  deletion (there is already a data-deletion flow at `/data-deletion/[code]`) does not
  silently leak. Tie avatar deletion into that existing flow.
- Abuse-report affordance + admin takedown path (can be a fast-follow, but design the
  key namespace and admin delete now).

## Security section (rule 13)

- Sensitive data: none of this stores secrets in object storage; credentials stay in
  env. R2 access keys are new secrets — store in Vercel env + pipeline env, never in
  code, scope them to the minimum buckets.
- Attack surface: the new one is `usercontent` (first UGC). Mitigations above. The
  `ingest` bucket goes PRIVATE (today raw sources are needlessly public).
- Least privilege: separate R2 API tokens per writer where practical; the user-avatar
  route's token should not be able to write to `media`.
- Fail closed: avatar route rejects on any validation failure; never persists a URL it
  didn't write.
- What we log / don't: log avatar upload events (user id, size, result) for abuse
  triage; never log image bytes or full tokens.

## Cost section (rule 8) — verified + council catch

- Storage: a few hundred shorts at ~20 MB plus images is single-digit GB →
  ~$0.015/GB/mo = pennies.
- Egress: $0 on R2.
- Operations: Class B (GetObject) $0.36/M beyond 10M/mo free; Class A (writes) $4.50/M
  beyond 1M/mo free. The one-time backfill copy of N objects is N Class A writes — price
  it before running (still cheap at our object counts, but not zero).
- STEADY-STATE DEPENDENCY: R2 stays cheap only because the custom domain edge-caches.
  With correct immutable `Cache-Control`, most views are edge cache hits (free), not
  Class B origin reads. Misconfigure the cache and every view bills a Class B read —
  this is the load-bearing assumption, verify the cache-hit ratio after cutover.
- One-time: GCS egress to copy existing objects out (pay Google once).

## Observability, backup, rollback, lock-in

- Observability: cache-hit ratio + 404 rate on `media.lorewire.com`, avatar upload
  success/abuse metrics, R2 ops dashboard + a budget alert (R2 has "Add Budget Alert").
- Backup: keep GCS as cold backup for several weeks post-cutover (R2 free path = no
  cross-region replication). Consider R2 object versioning on `media` to make an
  accidental delete recoverable.
- Rollback: because of dual-read, rolling back the writer flip is a config change
  (point writers back at GCS); reads keep working throughout.
- Lock-in: this makes Cloudflare the storage + CDN vendor (and Stream later). Accepted —
  R2 is S3-compatible, so a future exit is another S3-API swap, the same shape as this
  migration. Sized and accepted, not ignored.

## Upside to design for now (cheap optionality, do not over-build)

- Build `usercontent` as a general user-asset namespace (`avatars/...`, room for future
  `covers/...`, `og/...`), not an avatar-only bucket, so later UGC features reuse the
  same validated pipeline.
- Free egress makes aggressive prefetch / loop in the reels player affordable — but gate
  any public embed/hotlink/distribution behind the same abuse controls as avatars.

## Open questions (need answers before/at implementation)

1. Is `lorewire.com` already a zone in this Cloudflare account ("Shinez")? Needed to bind
   `media.` and `usercontent.` subdomains.
2. Who runs the Cloudflare console steps + provides the R2 S3 API token (Access Key ID /
   Secret) and account ID? I can write all the code; I cannot create the buckets/tokens.
3. Confirm subdomain choices: `media.lorewire.com` and `usercontent.lorewire.com` (vs
   `cdn.` / `uploads.`).
4. Avatar abuse policy: is a per-user rate limit + single-current-avatar quota + manual
   admin takedown enough for v1, or do we need automated scanning from day one?

## Work sequence (phased)

- Phase 0: confirm open questions, create buckets + custom domains + tokens.
- Phase 1: URL indirection + dual-read shim (code only, no behavior change). Independent
  value; ship and soak.
- Phase 2: avatar upload feature end-to-end against `usercontent` (can ship before the
  media migration; it's a new bucket, no cutover risk).
- Phase 3: media migration — copy, flip writers, backfill, soak, decommission.
