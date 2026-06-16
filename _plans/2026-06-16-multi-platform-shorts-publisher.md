# Multi-Platform Shorts Publisher

Date: 2026-06-16
Last revised: 2026-06-16 (LLM Council pass — see §20 revision log)
Status: Draft, awaiting approval
Owner: Yoav

Publish a rendered short to YouTube Shorts, TikTok, Instagram Reels, and Facebook Reels from inside the Lorewire short editor. Phase 1 ships YouTube-only via a single Vercel route. The multi-platform queue infra arrives in Phase 2, when there is a second platform to coordinate. Owner-only auth (Lorewire connects business-identity accounts, never Yoav's personal account).

The hard truth the council surfaced: the critical path is **four serial platform-review gauntlets** (Google OAuth verification, YouTube quota expansion, Meta App Review, TikTok audit) totaling 8–12 calendar weeks, not the 14–22 build days the first draft assumed. Phase 0 is review-application work, not code.

## 1. Goals

1. From a finished short (an entry in `short_renders` with a usable `output_url`), let the operator publish to a target platform in one click after Phase 1 ships, and to all four after Phase 3 clears review.
2. Each platform receives its own correctly-shaped metadata (title, caption, hashtags, category, thumbnail, privacy, scheduling), respecting per-platform length and count limits enforced at the transformer.
3. Publishing is durable: a Vercel function timing out, a Vercel deploy mid-upload, or a transient platform 5xx never silently drops a post. Phase 1 mitigates with idempotent retries; Phase 4 introduces a worker only if Vercel timeouts or volume actually force it.
4. Failures are diagnosable from logs alone (rule 14) and never leak secrets.
5. Audio rights are cleared **before** any publish fires. An autopublisher with no audio-source check earns strikes across all four platforms.
6. The OAuth identity is a business-owned Google Workspace and Meta Business account, never Yoav's personal account. One TOS strike on a personal account would nuke the entire pipeline.

## 2. Constraints and decisions (locked at intake, revised by council)

- **Account model**: owner-only. One connected channel/page/account per platform, owned by business identities.
- **Trigger UX**:
  - Phase 1: one-click "Publish to YouTube" on the short editor.
  - Phase 2+: multi-platform panel with checkboxes, customize panel, and scheduling.
- **Phase 1 platforms**: YouTube Shorts only. TikTok, IG, FB are gated on Meta/TikTok review and ship in Phase 2/3.
- **Hosting**:
  - Phase 1: Vercel route handler with `maxDuration=300`. At 60-second 1080p shorts (30–80 MB) the YouTube resumable upload fits inside the budget.
  - Phase 4 (deferred, only if forced): Cloud Run worker. At 40 publishes/day (one every 36 minutes) a min-instances=1 polling loop is theater. We earn the worker by feeling the pain first.
- **Storage of rendered MP4s**: Google Cloud Storage via the existing `src/lib/gcs.ts`. The bucket is public-read today; Phase 2 introduces a signed-URL helper because Meta's fetcher throttles `storage.googleapis.com` and frequently fails on it (known issue).
- **`workspace_id` is dropped from the schema** until tenant #2 exists. Adding it back is a one-line migration. Speculative generality wastes test coverage and query complexity for an outcome that may never arrive.
- **The OAuth identity is a business-owned account**, provisioned during Phase 0. Yoav's personal Google or Meta account never touches this pipeline.

## 3. Requirements

### Functional

- F1. Operator opens a short in the editor and sees a "Publish" panel. Phase 1: one platform row (YouTube). Phase 2+: four rows.
- F2. Smart defaults populate each row from a per-platform metadata transformer that enforces:
  - YouTube: title ≤ 100 chars, description ≤ 5000, ≤ 15 tags total ≤ 500 chars.
  - TikTok: caption ≤ 2200 chars, hashtag counts inside caption.
  - Instagram Reels: caption ≤ 2200 chars, ≤ 30 hashtags.
  - Facebook Reels: description ≤ 63206 chars.
  - All transformers reject payloads that exceed their limits at row-write time via a Zod schema.
- F3. The publish action surfaces a confirmation modal showing the per-platform action and the YouTube quota cost (~1,600 units).
- F4. A "Customize per platform" toggle (Phase 2+) reveals per-row editable title, caption, hashtags, category, thumbnail picker, privacy, and "publish at" time.
- F5. "Schedule" sets `scheduled_at` on the job row; Phase 2 introduces the queue picker that fires at or after that time. Phase 1 is publish-now only.
- F6. Status per platform: queued, uploading, processing, published (with public URL), failed (with reason and a retry button).
- F7. Idempotency: re-clicking publish on a row that already succeeded does not create a duplicate post. Re-clicking on a failed row creates a **new attempt row** linked to the same `publish_request`, with `attempt_number` incremented. The schema constraint in §6 enforces uniqueness on `(request_id, platform, attempt_number)` so retries and the no-duplicate guarantee coexist.
- F8. Operator can revoke a scheduled job before it fires.
- F9. **Audio clearance pre-check**. Before any publish fires, the request is gated on `audio_clearance_status` in `publish_requests`. The transformer rejects unknown-provenance audio. Acceptable sources are: silence, Lorewire-generated TTS, the platform's own commercial library tracks looked up via reference URL, or audio Yoav has uploaded with a rights attestation.

### Non-functional

- N1. Default daily volume target: up to 10 publishes per platform per day. The plan calls out the YouTube quota wall in §14.
- N2. Per-post end-to-end latency target for an immediate publish: under 5 minutes for a 60-second short on a healthy network, dominated by platform processing not by Lorewire.
- N3. No secret hits a browser. Tokens decrypt only inside the Vercel route handler / worker process.
- N4. Token refresh is automatic, single-flight per `(account, platform)` via Postgres advisory lock (prevents the two-concurrent-publishes refresh race).
- N5. Token refresh failure marks the row `needs_reauth` and the UI banner appears on the settings page.

## 4. Alternatives considered

### Option A: Vercel route handler, no worker, no queue table (recommended for Phase 1)

Summary: a single Next.js route at `/api/social/youtube/publish` with `maxDuration=300`. Resumable upload streams from the existing public GCS URL into `videos.insert`. Persistence is a 3-column `youtube_publishes` table (`short_id`, `external_post_id`, `published_at`). No queue, no worker, no scheduler.

Detail: a 60-second 1080p H.264 short renders to ~30–80 MB. YouTube's resumable upload tolerates the I/O time inside the 300-second budget. The Vercel-redeploy-mid-upload risk is real but rare and recoverable by re-clicking publish (idempotency by `external_post_id` lookup). For the YouTube-only Phase 1 this is the minimum viable shape.

**Recommended for Phase 1 because:** ships in 1–2 weeks, lets the four review applications run in parallel from day 1, and proves the YouTube flow before any queue infra exists to maintain.

### Option B: External worker queue (deferred to Phase 4)

Summary: a Cloud Run worker polls a `publish_jobs` table, picks ready jobs, runs the upload, writes results back.

Detail: the queue model is correct for "publish now or later, four platforms, retries, schedule-for-later." But at 40 publishes/day (one every 36 minutes) a min-instances=1 polling loop is sized for thousands of jobs/day. Vercel Cron + `pg_advisory_lock` does the same work for free until volume forces the worker.

**Deferred to Phase 4 because:** Phase 1 doesn't need it; Phases 2–3 can run on Vercel Cron + advisory locks. We earn the worker by feeling the pain.

### Option C: Third-party publishing SaaS (Ayrshare, Publer, Buffer, Hootsuite) — rejected on principle

Summary: rent the integration from a publishing SaaS that already passed each platform's review.

Why rejected: Lorewire builds its own surfaces. Renting the publisher puts a vendor between Lorewire and the per-platform metadata it needs to control (`madeForKids`, `share_to_feed`, `video_cover_timestamp_ms`, `disable_duet`, IG collaborator tags), loses cross-platform attribution that only works because the same `request_id` is shared across four uploads, and adds a vendor dependency to a surface that is core to Lorewire's product. We own the renderer, the editor, the storage layer, and the queue. We own the publisher too.

Reference prices for context only (do not treat as a live option): Ayrshare Premium ~$149/month, Publer Business ~$25/user/month. Not a fork — a closed door.

## 5. Architecture (Phase 1 — revised)

```
    +--------------------+         +-------------------------+
    | Lorewire web app   |         |   Postgres (Neon)       |
    | (Next.js, Vercel)  |         |                         |
    |                    |   sql   |  social_accounts        |
    |  Short editor      +-------->+  youtube_publishes      |
    |    Publish button  |         |  publish_requests       |
    |                    |         |    (audio_clearance,    |
    +---------+----------+         |     status)             |
              |                    +-------------------------+
              | POST /api/social/youtube/publish
              v
    +--------------------+
    | Vercel route       |
    | maxDuration=300    |    HTTPS resumable upload
    |                    +-----------------------------+
    | requireAdmin       |                             |
    | decrypt token      |                             v
    | stream from GCS    |              +---------------------+
    | call videos.insert |              | YouTube Data API v3 |
    | write public_url   |              +---------------------+
    +--------------------+
              ^
              |  reads MP4 bytes
              |  https://storage.googleapis.com/<bucket>/<path>.mp4
              |
    +--------------------+
    |  GCS (public-read) |
    +--------------------+
```

Phase 2+ architecture (deferred): adds a `publish_jobs` table, Vercel Cron firing every minute, `pg_advisory_lock` for single-flight per `(account, platform)`. Phase 4 architecture (deferred, only if forced): swaps the cron for a Cloud Run worker.

## 6. Data model

All raw-SQL, in line with `src/lib/schema.ts`. Columns named to match the existing snake_case convention. `workspace_id` is intentionally absent until tenant #2 exists.

### Phase 1 schema (YouTube-only)

```sql
-- The owner's connected social accounts. One row per platform connection.
CREATE TABLE IF NOT EXISTS social_accounts (
  id                UUID PRIMARY KEY,
  platform          TEXT NOT NULL,           -- 'youtube' | 'tiktok' | 'instagram' | 'facebook'
  display_name      TEXT NOT NULL,           -- 'Lorewire Stories' for the YT channel, etc.
  external_id       TEXT NOT NULL,           -- channel_id / user_id / page_id / ig_user_id
  scopes            TEXT NOT NULL,           -- space-separated scopes granted
  access_token_enc  BYTEA NOT NULL,          -- AES-256-GCM encrypted from day one
  refresh_token_enc BYTEA,                   -- nullable for platforms with long-lived tokens
  token_expires_at  TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'active', -- 'active' | 'revoked' | 'needs_reauth'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(platform, external_id)
);

-- Phase 1 persistence for YouTube. Minimal on purpose.
CREATE TABLE IF NOT EXISTS youtube_publishes (
  id                UUID PRIMARY KEY,
  short_id          UUID NOT NULL REFERENCES short_renders(id) ON DELETE RESTRICT,
  account_id        UUID NOT NULL REFERENCES social_accounts(id) ON DELETE RESTRICT,
  external_post_id  TEXT,                    -- YouTube video id once known
  public_url        TEXT,                    -- canonical viewer URL
  status            TEXT NOT NULL DEFAULT 'in_flight', -- 'in_flight' | 'published' | 'failed'
  last_error        TEXT,
  audio_clearance   TEXT NOT NULL,           -- 'silence' | 'tts' | 'platform_library' | 'rights_attested' | 'blocked'
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  UNIQUE(short_id, external_post_id)         -- one external post per short
);
```

### Phase 2+ schema (multi-platform queue)

Added when IG/FB land in Phase 2. The `youtube_publishes` table folds into `publish_jobs` via a migration that backfills.

```sql
-- One row per "I clicked Publish" action. Groups the per-platform jobs.
CREATE TABLE IF NOT EXISTS publish_requests (
  id                UUID PRIMARY KEY,
  short_id          UUID NOT NULL REFERENCES short_renders(id) ON DELETE RESTRICT,
  created_by        UUID NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  source            TEXT NOT NULL,           -- 'one_click' | 'customized' | 'scheduled'
  audio_clearance   TEXT NOT NULL            -- 'silence' | 'tts' | 'platform_library' | 'rights_attested' | 'blocked'
);

-- One row per platform target per attempt. Re-clicking a failed job inserts a new row.
CREATE TABLE IF NOT EXISTS publish_jobs (
  id                UUID PRIMARY KEY,
  request_id        UUID NOT NULL REFERENCES publish_requests(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES social_accounts(id) ON DELETE RESTRICT,
  platform          TEXT NOT NULL,
  attempt_number    INT NOT NULL DEFAULT 1,
  payload_json      JSONB NOT NULL,          -- Zod-validated platform-shaped metadata
  status            TEXT NOT NULL DEFAULT 'queued',
                                             -- 'queued' | 'uploading' | 'processing' | 'published' | 'failed' | 'cancelled'
  scheduled_at      TIMESTAMPTZ,             -- null = publish ASAP
  last_error        TEXT,
  external_post_id  TEXT,
  public_url        TEXT,
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  UNIQUE(request_id, platform, attempt_number)   -- F7-compatible: new attempt = new row
);

-- Partial index: only one in-flight or succeeded job per (request, platform).
-- Prevents duplicate posts while leaving failed rows free to retry.
CREATE UNIQUE INDEX IF NOT EXISTS publish_jobs_no_duplicate_success_idx
  ON publish_jobs(request_id, platform)
  WHERE status IN ('queued', 'uploading', 'processing', 'published');

CREATE INDEX IF NOT EXISTS publish_jobs_due_idx
  ON publish_jobs(status, scheduled_at)
  WHERE status = 'queued';

-- Platform-side outcome data pulled back on a 1h / 24h / 7d cadence.
-- This is the one Expansionist idea worth keeping. Cheap now, expensive to retrofit.
CREATE TABLE IF NOT EXISTS social_post_metrics (
  id                UUID PRIMARY KEY,
  job_id            UUID NOT NULL REFERENCES publish_jobs(id) ON DELETE CASCADE,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  views             BIGINT,
  watch_time_sec    BIGINT,
  ctr               DOUBLE PRECISION,
  comments          INT,
  shares            INT,
  reactions         INT,
  UNIQUE(job_id, captured_at)
);
```

The F7 contradiction the council caught is resolved two ways: `UNIQUE(request_id, platform, attempt_number)` lets retries insert new rows with `attempt_number = N+1`, and the partial unique index on non-terminal-or-succeeded statuses guarantees no platform sees a duplicate publish.

## 7. Per-platform integration specs

Endpoint URLs and scope names need a final pass against each platform's current developer docs at execution time, per rule 1. Per-platform length limits are enforced at the transformer (§3.F2) and the Zod schema rejects oversized payloads at row-write time.

### 7.1 YouTube Shorts (Data API v3)

- Endpoint: `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`
- Scope: `https://www.googleapis.com/auth/youtube.upload` (sensitive scope — requires Google OAuth verification, see §8).
- Auth: Google OAuth 2.0, refresh token encrypted at rest from day one.
- **YouTube Shorts classification**: classification is automatic based on aspect ratio (vertical, ≤ 1:1) and duration (≤ 60s). The `#Shorts` hashtag in title/description is **not** load-bearing as of late 2025; do not build caption logic around it. Re-verify current rules at execution time per rule 1.
- Metadata mapped: `snippet.title` (≤ 100 chars), `snippet.description` (≤ 5000), `snippet.tags[]` (≤ 15 items, total ≤ 500 chars), `snippet.categoryId`, `status.privacyStatus`, `status.publishAt` (RFC3339, requires `privacyStatus=private`), `status.madeForKids` (mandatory).
- Thumbnail: set via `POST .../videos/{id}/setThumbnail` after publish.
- Quota: 1,600 units per `videos.insert`. Default 10,000 units/day = ~6 uploads/day. See §14.

### 7.2 TikTok (Content Posting API)

- **Critical**: unaudited apps cannot direct-post. Posts land as drafts in the user's TikTok app and the user must open the app to publish manually. **One-click publish to TikTok cannot exist until audit clears.** Phase 3 ships sandbox-only with the UI clearly labeled "saves to TikTok drafts."
- Endpoint: `POST https://open.tiktokapis.com/v2/post/publish/video/init/`, then upload bytes to the returned signed URL, then poll `/v2/post/publish/status/fetch/`.
- Scope: `video.publish` (direct post, audit-gated) or `video.upload` (sandboxed drafts).
- Auth: TikTok OAuth, access tokens ~24h, refresh tokens ~365 days.
- Metadata mapped: `post_info.title` (caption ≤ 2200 chars), `post_info.privacy_level`, `post_info.disable_comment`, `post_info.disable_duet`, `post_info.disable_stitch`, `post_info.video_cover_timestamp_ms`.
- **Audio source rule**: TikTok's Commercial Sound Library is separate from the consumer one. Using consumer-licensed audio under a business-classified account is a TOS violation. The audio-clearance gate (§3.F9) blocks consumer-library tracks for this platform.
- Scheduling on TikTok itself is not exposed in the public API. Scheduled posts wait in our queue.

### 7.3 Instagram Reels (Graph API)

- Two-step:
  1. `POST .../{ig-user-id}/media?media_type=REELS&video_url=<signed_url>&caption=...&share_to_feed=true&access_token=...`
  2. Poll `GET .../{container-id}?fields=status_code` until `FINISHED`.
  3. `POST .../{ig-user-id}/media_publish?creation_id=<container-id>&access_token=...`
- **Signed URL requirement**: Meta's fetcher hammers `storage.googleapis.com` and frequently fails or throttles on public bucket URLs. Phase 2 introduces a `getSignedUrl()` helper in `lorewire-app/src/lib/gcs.ts` returning a 1-hour signed read URL, and passes that as `video_url` instead of the public URL.
- Prereq: Instagram Business or Creator account linked to a Facebook Page that our Meta app has been granted access to.
- Required perms: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`. All require Meta App Review and Business Verification.
- Metadata mapped: `caption` ≤ 2200 chars with ≤ 30 hashtags inline, `cover_url` (signed URL), `audio_name`, `share_to_feed`.
- Scheduling: Graph API does not accept a future timestamp for Reels. Hold in our queue.

### 7.4 Facebook Reels (Graph API)

- Three-step on a Page:
  1. `POST .../{page-id}/video_reels?upload_phase=start&access_token=<page_token>` → returns `video_id`, `upload_url`.
  2. `POST <upload_url>` with the file bytes (`file_url` for hosted, signed URL preferred — same Meta-fetcher issue as IG).
  3. `POST .../{page-id}/video_reels?video_id=<id>&upload_phase=finish&video_state=PUBLISHED&description=<caption>&access_token=<page_token>`.
- Required perms: `pages_manage_posts`, `pages_read_engagement`, `publish_video`. Same Meta App Review path as Instagram.
- Metadata: `description` ≤ 63206 chars.
- Scheduling: `video_state=SCHEDULED` plus `scheduled_publish_time` is supported up to ~6 months out. We default to holding in our queue for consistency with the other three platforms.

## 8. Auth and OAuth flows

One connection per platform, performed from `/admin/settings/social-accounts`. The OAuth identity is a business-owned Google Workspace account and a business-owned Meta Business account, **never Yoav's personal Google or Meta account**. The account-ban blast radius is the whole pipeline — one personal-account TOS strike kills YouTube, IG, FB simultaneously.

- Server-side OAuth callbacks at `/api/social/oauth/{platform}/callback`.
- **CSRF on every callback**:
  - `state` parameter: cryptographically random, 256-bit, single-use, TTL 10 minutes, bound to the session (HMAC over `session_id` so the callback can verify the same browser started the flow).
  - PKCE (`code_verifier` + `code_challenge`) on every flow that supports it (Google, TikTok). Meta's flow does not support PKCE; rely on the state binding alone there.
  - `state` and `code_verifier` stored in a short-lived `oauth_flows` table with `expires_at`, deleted after the callback succeeds or expires.
- **Token encryption at rest from day one**. AES-256-GCM with a per-row nonce. Key in `LOREWIRE_TOKEN_KEY` env (separate from `NEXTAUTH_SECRET`). Key rotation slot `LOREWIRE_TOKEN_KEY_PREV`. Not deferred "one week" as the Executor suggested — it's a 30-minute job and reviewers ask about it.
- **Single-flight refresh**: a Postgres advisory lock per `(account.id)` serializes concurrent refreshes when two publishes fire within the same minute.
- Refresh failure: row marked `needs_reauth`, UI banner appears on the settings page.
- Revocation: Disconnect click revokes at the platform AND nulls the cipher fields, marks the row `revoked`.

### The four serial review gauntlets (Phase 0 critical path)

1. **Google OAuth verification** for the `youtube.upload` sensitive scope. Required regardless of user count. Needs: verified domain, public homepage, public privacy policy URL, public ToS URL, recorded demo video showing the actual app exercising the scope. Calendar: 1–4 weeks once submitted, longer if any link bounces.
2. **YouTube Data API quota expansion**. Default quota is 10,000 units/day = ~6 uploads/day. Submit the audit form immediately on Phase 0 start. First denial is common for solo operators without published privacy policy / ToS / demo video — same artifacts as the OAuth verification. Calendar: 2–8 weeks.
3. **Meta App Review** for `instagram_content_publish`, `pages_manage_posts`, `publish_video`. Requires Meta Business Verification (legal-entity-level KYC), privacy policy URL, ToS URL, data-deletion callback endpoint (`/api/social/oauth/meta/data-deletion`), and a screencast of the actual app performing each requested permission. Calendar: 1–6 weeks, frequent bounce on missing artifacts.
4. **TikTok app audit** for `video.publish`. Calendar: 1–4 weeks. Until cleared, our integration can only save drafts the user manually publishes.

Phase 0's deliverable is "all four clocks started this week," not code.

## 9. Publish flow (UX)

### Phase 1 (YouTube only)

A single row at the bottom of `ShortEditorClient`:

```
+--------------------------------------------------+
| Publish this short to YouTube                    |
|--------------------------------------------------|
| Audio clearance:  [ ✓ Lorewire TTS ]             |
| Privacy:          [ Public ▾ ]                   |
| Made for kids:    [ No ]                         |
|                                                  |
| [ Publish to YouTube ]                           |
|                                                  |
| Confirmation: "This will use ~1,600 YouTube      |
| quota units (about 6/day default)."              |
+--------------------------------------------------+
```

The confirmation modal shows the quota cost. If the audio clearance is `blocked` (unknown provenance), the button is disabled with an explanatory tooltip.

### Phase 2+ (multi-platform)

The panel expands to four rows with checkboxes, a "Publish at" row, and a "Customize per platform" disclosure. Each customize card shows: title (where applicable), caption, hashtag chips (with the per-platform count limit displayed), thumbnail picker, privacy dropdown, platform-specific toggles.

Defaults come from a `mapShortToPlatformPayload(short, platform)` function per platform that enforces the limits in §3.F2.

## 10. Security and safety (rule 13)

- **Sensitive data**: OAuth access tokens, refresh tokens, the encryption key, the audio-rights attestations.
- **Attack surface**: OAuth callback routes, the Publish API route, the encryption-key storage, the Meta data-deletion callback.
- **Token storage**: AES-256-GCM with a per-row nonce. Keys in env, not in code. Token never logged in cleartext. Stored encrypted from the moment OAuth returns.
- **OAuth identity isolation**: business-owned Google Workspace + Meta Business accounts, provisioned in Phase 0. Never Yoav's personal account.
- **CSRF**: detailed in §8 — `state` + PKCE + session-binding + TTL on a dedicated `oauth_flows` table, not a "follow-up."
- **Authz on Publish**: the API route checks `requireAdmin()`. No client-supplied `account_id` is trusted; the route resolves `account_id` from `platform`.
- **Input validation**: per-platform Zod schemas validate payloads at row-write time. Bad payloads never reach the platform.
- **Audio-rights gate**: §3.F9. No publish fires with `audio_clearance = 'blocked'`. Acceptable values are TTS-generated, silence, platform-library-attested, or rights-attested.
- **Outbound calls**: every fetch to a platform has a 60s soft / 280s hard timeout, AbortController-backed.
- **Secrets in logs**: a `redact(obj, ['access_token','refresh_token','authorization','cookie'])` wrapper at every log statement that takes an object.
- **Key rotation**: `LOREWIRE_TOKEN_KEY` + `LOREWIRE_TOKEN_KEY_PREV` slot. Runbook lives at `_plans/runbooks/social-key-rotation.md` (to be written at impl time).
- **Account-ban blast radius**: a single TOS strike on the business identity kills the platform connection but not Yoav's personal life. Monitor strikes by polling each platform's strike/violation endpoint where available (YouTube and Meta both expose this).
- **Cross-posting policy exposure**: each platform's automation policy treats identical-content cross-posts differently. Caption templates should produce platform-specific copy, not byte-identical strings.
- **Meta data-deletion callback**: `/api/social/oauth/meta/data-deletion` must accept signed deletion requests from Meta and return a confirmation URL within 24 hours. Required for App Review. Implement in Phase 0 alongside the privacy policy.
- **GCS source URL staleness**: if a render is garbage-collected mid-upload the public URL 404s. Pin rendered shorts in GCS for at least 7 days post-publish via the bucket lifecycle rule, or copy to a `publish-staging/` prefix with TTL.

Per rule 1, current best practices to check at execution time:
- OWASP ASVS section 2 for OAuth flows.
- Google's current sensitive-scope verification checklist.
- Meta's current security checklist for Business apps and the data-deletion-callback spec.
- TikTok's data handling and PII restrictions.

## 11. Observability (rule 14)

Every step emits a namespaced log line. Grep targets:

- `[social publish click]` — UI fires Publish. Logs `{requestId, platforms, scheduledAt, source, audioClearance}`.
- `[social publish request]` — API route handler. Logs `{requestId, jobIds, audioClearance}`.
- `[social publish audio-check]` — audio-rights gate result. Logs `{requestId, clearance, source, blockedReason}`.
- `[social publish upload]` — bytes start. Logs `{jobId, platform, bytes, sourceUrl}`.
- `[social publish upload-progress]` — every 10% on resumable uploads. Logs `{jobId, percent}`.
- `[social publish platform-call]` — every outbound HTTP to a platform. Logs `{jobId, platform, method, urlPath, status, ms}` with redaction.
- `[social publish complete]` — job lands. Logs `{jobId, platform, externalPostId, publicUrl, totalMs}`.
- `[social publish fail]` — job fails. Logs `{jobId, platform, attempts, reasonCode, willRetry, nextAttemptAt}`.
- `[social oauth callback]` — OAuth callback. Logs `{platform, stateValid, pkceValid, externalId}`.
- `[social oauth refresh]` — token refresh. Logs `{platform, accountId, lockAcquired, expiresIn}`.
- `[social oauth revoke]` — disconnect. Logs `{platform, accountId}`.
- `[social oauth verify]` — sensitive-scope verification status check. Logs `{platform, status}`.
- `[social metrics poll]` — Phase 2+ outcome-data fetch. Logs `{jobId, platform, cadence, views, watchTimeSec}`.
- `[social takedown]` — platform-side takedown / strike webhook received. Logs `{platform, accountId, postId, reason}`.

Levels: `info` for the lifecycle, `warn` for retries and refresh-lock contention, `error` only for terminal failures.

A per-platform `social_metrics_daily` table (counts of publishes, fails, p50/p95 duration, quota burned) is built incrementally in Phase 2 so the operator sees publish health without grepping logs.

**Alerting**: a daily Vercel Cron at 09:00 emails Yoav if any platform had a `social publish fail` count > 0 in the previous 24 hours, or if any `social_accounts.status != 'active'`. No 3am pages.

## 12. Settings (rule 15)

New settings surface under `admin/settings`:

- **Social accounts panel** (new): Connect / Reconnect / Disconnect per platform. Shows expiry, scopes, last successful publish, current verification status (e.g. "Google OAuth verified", "Meta App Review pending").
- **Default publish behavior**:
  - Default privacy per platform (public / unlisted / private). Default: public.
  - Default hashtag set per platform (chip editor; UI shows per-platform count limit).
  - Default caption template per platform (e.g. `{title}\n\n{description}\n\n{hashtags}`). Supports `{title}`, `{description}`, `{hashtags}`, `{url}`.
  - `madeForKids` default for YouTube (false).
  - `share_to_feed` default for IG (true).
  - `disable_comment`, `disable_duet`, `disable_stitch` defaults for TikTok (all false).
- **Audio source defaults**:
  - Default audio source library per platform (Lorewire TTS, silence, platform commercial library).
  - "Block publish if audio clearance is unknown" toggle (default: on).
- **Scheduling** (Phase 2+):
  - Operator timezone.
  - Time-of-day presets for the schedule picker.
- **Quota and safety**:
  - "Pause all publishing" kill switch.
  - Daily max publishes per platform (rate limit on our side, separate from the platform's).
  - Daily cost ceiling (in YouTube quota units; aborts publish if the next call would push over).
  - Retry cap per job (default: 6, respecting platform `Retry-After`).
- **Intentionally not exposed**: encryption key, polling interval, Cron schedule. Operational config.

Each setting lands at `src/app/admin/(panel)/settings/` with `SettingControls` components matching the existing patterns.

## 13. Testing (rule 18)

- **Pure helpers** (unit, Vitest, follow `src/lib/short-config.test.ts` style):
  - `mapShortToPlatformPayload` for each platform, including caption-template substitution, hashtag deduplication, length capping per platform (YouTube 100/5000/15-tags, TikTok 2200, IG 2200/30-tags, FB 63206).
  - `redact()` token-stripping wrapper.
  - `tokenCipher.encrypt/decrypt` round-trip with the right key, wrong key, and prev-key fallback.
  - `nextRetryAt(attempts)` exponential-backoff calculator.
  - `validateOAuthState({state, sessionId, now})` — the CSRF state-binding check. Tests cover: valid state, expired state, wrong-session state, replayed state.
  - `audioClearanceGate({source, platform})` — F9 gate. Tests cover: TTS pass, silence pass, platform-library pass, unknown block, consumer-library block on TikTok.

- **Schema regression (F7 contradiction)**:
  - **Write the failing test first**: a test that re-publishes a `failed` job with the original `UNIQUE(request_id, platform)` constraint and expects an INSERT failure. Run it on the fixed schema (`UNIQUE(request_id, platform, attempt_number)` + partial index) and confirm it now passes.
  - A test that re-publishes a `published` job and expects rejection by the partial index.

- **YouTube route** (integration, with a fake Postgres pool and `msw` mocking the YouTube API):
  - Streams from a GCS public URL successfully.
  - Recovers from a token expiry mid-call via single-flight refresh.
  - Handles a 429 with `Retry-After` correctly.
  - Records `external_post_id` and `public_url` on success.
  - Marks `failed` with `last_error` on a terminal 4xx.

- **OAuth callbacks** (integration):
  - State parameter validation passes for a valid flow.
  - State parameter validation fails for: expired state, wrong-session state, replayed state, missing state, tampered state.
  - PKCE verification passes / fails as expected for Google and TikTok.

- **Per-platform uploader** (Phase 2+, contract tests with `msw` or `nock`):
  - Each platform module produces the right sequence of HTTP calls for a real-shaped payload.
  - Token expiry mid-call triggers refresh-then-retry.
  - Captures and surfaces the platform's error code in `last_error`.

- **End-to-end** (manual, gated): a script `npm run e2e:social` publishes a 5-second test short to a private channel/page on each platform and verifies the resulting URL responds 200. Run before each release that touches the publisher.

- **Coverage out of scope**: actual platform reachability in CI (would flap). Captured by the gated E2E.

## 14. Cost analysis (rule 8)

Verified against live pricing at execution time. As of session date 2026-06-16:

| Item | Cost | Note |
|---|---|---|
| YouTube Data API v3 | $0 | 10,000 unit/day default. `videos.insert` = 1,600 units → **~6 uploads/day max** until quota expansion approved. Re-verify the unit cost in Google's current quota docs before launch. |
| TikTok Content Posting API | $0 | Rate-limited, exact limits not publicly documented. Audit is free, 1–4 weeks. |
| Meta Graph API (IG + FB) | $0 | Rate-limited per app. Business Verification + App Review is free, 1–6 weeks. |
| Vercel function-minutes (Phase 1) | ~$0–5/month | ~6 × 2 minutes / day = ~12 min/day = ~360 min/month, well inside Pro tier. Verify current Vercel function pricing. |
| GCS egress to platform fetchers | ~$0.01–0.10/day | At 40 publishes × 50 MB = 2 GB/day. Standard GCS egress to internet ~$0.12/GB → ~$0.24/day = ~$7/month at full multi-platform Phase 3 volume. |
| Cloud Run (Phase 4, deferred) | ~$5–10/month | Only if Phase 4 ships. Until then, $0. |
| GCS storage of rendered shorts | already paid | No new cost. |
| Encryption key management | $0 | Env vars + manual rotation. KMS later if multi-tenant. |

**Flagged for decision**: the YouTube 6-uploads-per-day default quota is the only hard wall. Submit the expansion form in Phase 0 day 1.

## 15. Phased delivery (council-revised)

Total calendar to "all four platforms publishing publicly": **8–12 weeks**, gated on four serial review gauntlets (§8). Build effort: ~3–5 weeks of actual coding spread across that window. The build is not the critical path.

### Phase 0 — Review applications and platform identity (this week, no publisher code yet)

Parallelizable. Every day this is delayed adds a day to the final ship date.

- Stand up `lorewire.com/privacy` and `lorewire.com/terms` if they don't exist. Public, link-checked, plain language.
- Provision a business-owned Google Workspace account and a business-owned Meta Business account. Verify the domain in both.
- Record a 60-second demo video showing the planned publish flow (a wireframe is acceptable; reviewers want to see intent).
- **Submit all four review applications**:
  - Google OAuth sensitive-scope verification for `youtube.upload`.
  - YouTube Data API quota expansion.
  - Meta App Review for `instagram_content_publish`, `pages_manage_posts`, `publish_video`.
  - TikTok app audit for `video.publish`.
- Wire `/api/social/oauth/meta/data-deletion` (Meta App Review requires it to be live before submission).

### Phase 1 — YouTube end-to-end via Vercel route (~1–2 weeks once Phase 0 is in flight)

- Schema: `social_accounts` + `youtube_publishes` migrations (§6 Phase 1 schema).
- `/admin/settings/social-accounts` page with YouTube Connect / Disconnect.
- OAuth callback at `/api/social/oauth/youtube/callback` with `state` + PKCE + session-binding + TTL.
- Token encryption from day one. `oauth_flows` table for CSRF state.
- `/api/social/youtube/publish` route, `maxDuration=300`. Reads MP4 from public GCS URL, streams into `videos.insert` resumable, writes `external_post_id` and `public_url`.
- Audio-clearance gate (§3.F9) wired but with permissive defaults until Phase 0 verification clears (otherwise we cannot test).
- "Publish to YouTube" button on the short editor.
- Observability namespaces from §11 active from the first commit.
- Tests from §13 (pure helpers + YouTube route integration + OAuth callbacks) green.
- Definition of done: §19.

### Phase 2 — Instagram + Facebook Reels (~1–2 weeks, after Meta App Review clears)

- `getSignedUrl()` helper in `lorewire-app/src/lib/gcs.ts` (Meta fetcher fails on public GCS URLs).
- Schema migration: introduce `publish_requests`, `publish_jobs`, `social_post_metrics`. Backfill `youtube_publishes` rows into `publish_jobs`.
- IG and FB uploader modules behind the `Uploader` interface (§17).
- Vercel Cron at 1-minute cadence polls `publish_jobs` with `pg_advisory_lock` for single-flight. No worker yet.
- Customize-per-platform UI.
- Metrics poll Cron: 1h / 24h / 7d cadence fills `social_post_metrics`.

### Phase 3 — TikTok (~1 week, after TikTok audit clears, OR earlier in sandbox-only mode)

- TikTok uploader module.
- Until audit clears, the UI labels the action "Save to TikTok drafts" and disables "publish public."
- Audio-clearance gate enforces TikTok Commercial Sound Library rules (§7.2).

### Phase 4 — Cloud Run worker (deferred, ship only if forced)

Ship only if any of the following hits:
- Vercel function timeouts become a recurring failure mode.
- Volume crosses ~200 publishes/day where Cron + advisory locks no longer comfortably fit.
- A platform's resumable-upload pattern genuinely cannot complete in 300s.

Until then, Vercel Cron + `pg_advisory_lock` is sufficient.

### Phase 5 — Polish

- Daily metrics dashboard.
- Kill-switch UI.
- Per-platform retry cap and cost ceiling enforcement in the UI.
- Buy-vs-build review: do we still want to own this surface, or has Publer become the answer?

## 16. Open questions

1. ~~Which blob storage hosts the rendered short MP4?~~ **Resolved 2026-06-16**: Google Cloud Storage via `lorewire-app/src/lib/gcs.ts`, public-read bucket. Phase 2 introduces a signed-URL helper because Meta's fetcher throttles public GCS URLs.
2. ~~Hosting platform for the worker.~~ **Resolved 2026-06-16**: deferred to Phase 4. Phase 1 uses a Vercel route handler; Phase 2–3 use Vercel Cron + `pg_advisory_lock`. Cloud Run lands only if forced.
3. ~~Workspace_id from day one?~~ **Resolved 2026-06-16 (council)**: dropped until tenant #2 exists. One-line migration later.
4. ~~Buy-vs-build?~~ **Resolved 2026-06-16**: build. Lorewire does not rent surfaces it can own. See §4 Option C.
5. Cover/thumbnail UX: shared picker producing `cover_url` + frame timestamp, or per-platform pickers? Decide at Phase 2 kickoff.
6. Retry policy specifics: default plan respects `Retry-After`, caps at 1 hour, total 6 attempts. Adjust per platform once we see real failure rates.
7. Should `audio_clearance` be a column on `publish_requests` (current plan) or a separate `audio_attestations` table linked to `short_renders`? The latter scales better when one short publishes more than once, but adds a join.

## 17. Implementation notes

- Add tables via the existing migration mechanism in `src/lib/schema.ts` (raw SQL, idempotent CREATE).
- Phase 1 lives entirely in `lorewire-app/src/app/api/social/` + `lorewire-app/src/app/admin/(panel)/settings/social-accounts/` + the new "Publish to YouTube" surface on `ShortEditorClient`. No new top-level folder until Phase 4.
- Phase 1 reads MP4 bytes via the public URL `https://storage.googleapis.com/<GCS_BUCKET>/<path>`. Phase 2 switches Meta calls to signed URLs.
- The web app's API routes go through `apiRoute.authed` (matching the existing reference in `_reference/youtubestudio/`) and re-check ownership server-side.
- Phase 2+ per-platform modules share a single `Uploader` interface:
  ```ts
  interface Uploader {
    upload(job: PublishJob, source: VideoSource, account: SocialAccount): Promise<UploadResult>;
  }
  ```
- Never import the uploader modules in browser code. Enforce with an `import/no-restricted-paths` ESLint rule.
- Phase 4 worker (if it ships): new top-level folder `publisher-worker/`, sibling of the existing render service, Cloud Run target `lorewire-publisher`.

## 18. Risks

- **Calendar gated on four serial reviews**: 8–12 weeks to "all four publishing publicly." Mitigated by starting all four in Phase 0 day 1.
- **Google OAuth verification denial** for a solo operator without published privacy policy / ToS / demo. Mitigated by Phase 0 producing those artifacts before submission.
- **Meta App Review bounce**: frequent on first submission. Mitigated by following Meta's screencast template exactly and wiring the data-deletion callback before submitting.
- **TikTok audit delay**: integration ships sandbox-only (drafts) in Phase 3, audit pursued in parallel.
- **YouTube quota wall at 6/day**: real and binding. Mitigated by quota expansion application in Phase 0.
- **Music licensing / Content ID strikes**: fatal for autoposting. Mitigated by the audio-clearance gate (§3.F9) and platform-specific audio-source rules (§7.2 TikTok Commercial Sound Library).
- **Account-ban blast radius**: one TOS strike on the business account suspends the platform connection but not Yoav's personal account. Mitigated by business-identity OAuth (§8).
- **Token theft**: encryption + redaction. Residual risk if env key leaks. Mitigated by key rotation runbook.
- **Meta fetcher failures on public GCS URLs**: known issue. Mitigated by signed URLs in Phase 2.
- **GCS render garbage-collected mid-upload**: 404 surface area. Mitigated by 7-day lifecycle pin or publish-staging prefix (§10).
- **Token refresh races**: two publishes in the same minute can race. Mitigated by Postgres advisory lock per `account.id`.
- **Cross-posting TOS exposure**: identical-content cross-posts can be flagged. Mitigated by per-platform caption transformers, not byte-identical strings.
- **Platform-side takedowns / strikes mid-flight**: webhook receivers in `/api/social/webhooks/{platform}` (Phase 2+) write to `social_takedowns` and pause the affected account.

## 19. Definition of done (Phase 1)

- Business-owned Google Workspace account connected as the YouTube identity (not Yoav's personal account).
- `lorewire.com/privacy` and `lorewire.com/terms` live and link-checked.
- Google OAuth sensitive-scope verification submitted (status visible in settings).
- YouTube Data API quota expansion submitted.
- Meta App Review and TikTok audit submitted (work happens in parallel — Phase 1 does not need them to clear).
- One click on a finished short publishes it as a YT Short with correctly-shaped metadata and a public URL written back to `youtube_publishes.public_url`.
- The audio-clearance gate (§3.F9) blocks an unknown-source publish.
- A re-clicked failed publish creates a new row with `attempt_number` incremented; a re-clicked successful publish is refused by the partial unique index.
- CSRF on the OAuth callback rejects: expired state, wrong-session state, replayed state, missing state, tampered state, missing/mismatched PKCE verifier.
- Tokens are encrypted at rest with `LOREWIRE_TOKEN_KEY`; rotation via `LOREWIRE_TOKEN_KEY_PREV` works.
- All tests in §13 green.
- Observability namespaces from §11 produce diagnosable logs for: a successful publish, a token-refresh race, a 4xx terminal failure, a 5xx retry, an audio-clearance block.

## 20. Revision log

- **2026-06-16 (initial draft)**: First plan written after intake.
- **2026-06-16 (buy-vs-build closed)**: Yoav rejected third-party publishing SaaS as a viable alternative. §4 Option C rewritten as rejected-on-principle. §14 buy-vs-build comparison rows removed. §15 Phase 0 "make the buy-vs-build call" item removed. §16 question 4 resolved. Lorewire owns the publisher.
- **2026-06-16 (LLM Council pass)**: Restructured phases to put review applications in Phase 0 and YouTube-only Vercel route in Phase 1. Dropped `workspace_id` until tenant #2 exists. Fixed the F7 vs `UNIQUE(request_id, platform)` contradiction with `(request_id, platform, attempt_number)` + a partial index on non-terminal-or-succeeded statuses. Dropped the stale `#Shorts` heuristic from §7.1. Moved signed GCS URLs from "future work" to Phase 2 because Meta's fetcher throttles public bucket URLs. Specified CSRF concretely (`state` + PKCE + session-binding + TTL) and pulled it into Phase 1, not "follow-up." Added Google OAuth sensitive-scope verification as a fourth review gauntlet. Added music licensing / Content ID gate (§3.F9). Added business-identity OAuth requirement (§8, §10) so a personal-account strike does not nuke the pipeline. Added per-platform caption length and hashtag count limits to the transformer contract (§3.F2). Added single-flight token refresh via Postgres advisory lock (§N4, §8). Added GCS render lifecycle pin (§10). Added daily failure-summary email instead of 3am paging (§11). Added cost rows for Vercel function-minutes, GCS egress, and buy-vs-build against Publer / Ayrshare (§14). Added `social_post_metrics` table (the one Expansionist idea worth keeping). Cloud Run worker deferred to Phase 4. Build estimate is no longer a headline number; calendar of 8–12 weeks gated on four serial reviews is.

