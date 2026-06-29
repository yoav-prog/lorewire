# YouTube + TikTok auto-publish for shorts + admin Socials section

Date: 2026-06-24
Branch: `feat/youtube-and-tiktok-auto-publish` (off `feat/instagram-auto-publish`)
Status: APPROVED — implementation in progress

## Goal

Auto-publish each rendered short to two more platforms — YouTube
(`@LoreWireHQ`) and TikTok — mirroring the FB + IG flow that already
exists. Reorganize the admin Settings into a dedicated **Socials**
section so the four publishers live next to each other, each with its
own per-platform defaults editable globally and overrideable per-short.

## Scope

In scope:
- New `publish-to-youtube.ts` module (videos.insert + captions.insert)
- New `publish-to-tiktok.ts` module (Content Posting API, async poll)
- Two new `*_posts` tables mirroring `facebook_posts` / `instagram_posts`
- Two new retry crons (`/api/retry_youtube_publishes`,
  `/api/retry_tiktok_publishes`)
- Wire both new publishers into `render_short` route's auto path
- Two new manual `PublishTo{Platform}Button` components on
  `/admin/shorts/[id]`
- Admin Settings reorganization: new "Socials" tab containing
  Instagram, Facebook, YouTube, TikTok, and Cross-platform sub-sections
- Two one-time CLI scripts to mint refresh tokens:
  `scripts/get-youtube-refresh-token.ts` and
  `scripts/get-tiktok-refresh-token.ts`

Out of scope (Phase 2, future PR):
- LLM-generated SEO metadata shared across all four publishers
- End-user OAuth TikTok (per
  `_plans/phase0-review-applications/tiktok-audit.md` — different
  product feature, different credential model)
- A "social mass schedule" UI

## Context

Verified findings backing the architecture:

- **YouTube Data API v3 `videos.insert`** quota cost per call: 1 unit
  in the Video Uploads bucket. Daily cap 100 uploads/day. Well above
  LoreWire's velocity.
- Required snippet fields: `title`, `categoryId`. Optional:
  `description`, `tags[]`, `defaultLanguage`. Status: `privacyStatus`,
  `selfDeclaredMadeForKids`, `containsSyntheticMedia`.
- A video becomes a YouTube Short via vertical aspect + ≤60s. The
  `#Shorts` hashtag is no longer load-bearing for classification but
  still standard for SEO.
- **TikTok Content Posting API** supports two endpoints:
  - `/v2/post/publish/inbox/video/init/` — drops the video as a draft
    in the creator's TikTok inbox. Works without app audit.
  - `/v2/post/publish/video/init/` (Direct Post) — posts immediately.
    **Requires app audit**, 1–4 weeks per the existing
    `_plans/phase0-review-applications/tiktok-audit.md` doc.
- TikTok rate limit: 6 req/min per access token. Generous for LW.
- TikTok `post_info.title` carries hashtags inline (no separate field).
  Cap is 2200 UTF-16 runes; SEO sweet spot is 150–300 chars with
  focus keyword in the first 50.
- TikTok `post_info.is_aigc: true` shows the "Creator labeled as
  AI-generated" tag, matching the AI gate.
- TikTok `privacy_level` must match one of the values returned by
  `/v2/post/publish/creator_info/query/` first — TikTok dynamically
  restricts what each account can use.
- `google-auth-library@10.7.0` already in `package.json`; no new deps
  for YouTube OAuth.

SEO findings shaping the default templates:
- YouTube Shorts: title ≤60 chars, 4-6 words, keyword in first 3;
  description 150-200 words with keyword in first 2 sentences;
  hashtags 3-5 (60+ = all ignored); SRT captions outrank auto-captions
  for indexing.
- TikTok: caption 150-300 chars sweet spot, keyword in first 50
  chars (the visible-before-"more" cut), hashtags 3-5, avoid #fyp
  and #foryou (saturated, zero ranking signal in 2026).

## Architecture

Each platform publisher is a stand-alone `publish-to-<platform>.ts`
module exporting the same shape:

- `publishShortTo<Platform>(args, deps)` — the entry point called from
  the render route's auto path and the admin's manual-publish action.
- `attempt<Platform>PublishForRow(rowId, deps)` — the retry-cron entry
  point. Resumes from any in-flight intermediate state (e.g.
  TikTok's `publish_id`, IG's `container_id`).
- `deleteLatestPostedRowForStory(storyId, deps)` — for the manual
  "delete previous and republish" admin flow.
- `SETTING_AUTO_PUBLISH`, `SETTING_<other>` exported as canonical
  strings so the admin settings page and the publisher read the same
  keys.
- `DEFAULT_*_TEMPLATE` exported constants.

Each platform owns a dedicated `*_posts` table with the same status
machine (`pending` → `posted` | `failed` | `deleted`) and the same
fields with platform-specific additions.

Render route calls each publisher in a fire-and-forget catch block so
a publisher hiccup never breaks the render response. Failures land in
the platform-specific table with `status='failed'` and the retry cron
picks them up.

## Schema

### `youtube_posts`

```sql
CREATE TABLE youtube_posts (
  id                text PRIMARY KEY,
  story_id          text NOT NULL,
  render_id         text,
  channel_id        text NOT NULL,         -- snapshotted from env for audit
  trigger           text NOT NULL,          -- 'auto' | 'manual'
  video_url         text NOT NULL,
  title             text NOT NULL,
  description       text NOT NULL,
  tags_json         text NOT NULL,          -- JSON array
  category_id       text NOT NULL,          -- '24' for Entertainment
  made_for_kids     integer NOT NULL,       -- 0/1
  synthetic         integer NOT NULL,       -- 0/1
  privacy           text NOT NULL,          -- 'public' | 'unlisted' | 'private'
  status            text NOT NULL,          -- 'pending' | 'posted' | 'failed' | 'deleted'
  external_video_id text,
  yt_error_reason   text,                   -- YT returns string reasons
  error_message     text,
  attempts          integer,
  created_at        text NOT NULL,
  posted_at         text,
  deleted_at        text
);
CREATE INDEX idx_youtube_posts_story ON youtube_posts(story_id);
CREATE INDEX idx_youtube_posts_status ON youtube_posts(status);
```

### `tiktok_posts`

```sql
CREATE TABLE tiktok_posts (
  id                text PRIMARY KEY,
  story_id          text NOT NULL,
  render_id         text,
  open_id           text NOT NULL,         -- snapshotted from env for audit
  trigger           text NOT NULL,
  video_url         text NOT NULL,
  caption           text NOT NULL,         -- caption with inline hashtags
  privacy_level     text NOT NULL,
  post_mode         text NOT NULL,        -- 'direct' | 'inbox'
  is_aigc           integer NOT NULL,      -- 0/1
  disable_duet      integer NOT NULL,
  disable_stitch    integer NOT NULL,
  disable_comment   integer NOT NULL,
  publish_id        text,                  -- TT's async publish id
  status            text NOT NULL,
  external_post_id  text,
  tt_error_code     text,
  error_message     text,
  attempts          integer,
  created_at        text NOT NULL,
  posted_at         text,
  deleted_at        text
);
CREATE INDEX idx_tiktok_posts_story ON tiktok_posts(story_id);
CREATE INDEX idx_tiktok_posts_status ON tiktok_posts(status);
```

## Credentials and OAuth model

Both YouTube and TikTok use the owner-channel pattern (matches FB +
IG). One LoreWire account per platform, OAuth granted once, refresh
token stored in env, never DB, never logs.

### YouTube env vars

```
YOUTUBE_CLIENT_ID=…
YOUTUBE_CLIENT_SECRET=…
YOUTUBE_REFRESH_TOKEN=…
YOUTUBE_CHANNEL_ID=…           # defense-in-depth check
```

### TikTok env vars

```
TIKTOK_CLIENT_KEY=…
TIKTOK_CLIENT_SECRET=…
TIKTOK_REFRESH_TOKEN=…
TIKTOK_OPEN_ID=…               # defense-in-depth check
```

### OAuth setup scripts (one-time, local-only)

`scripts/get-youtube-refresh-token.ts` — opens the Google consent URL
in the default browser with `scope=https://www.googleapis.com/auth/youtube.upload`,
runs a tiny localhost callback server, exchanges the code for a
refresh token, prints it for paste into Vercel env. Never automated.

`scripts/get-tiktok-refresh-token.ts` — same shape for TikTok, scope
`video.upload video.publish user.info.basic`.

Both scripts are throwaway dev tooling — gitignored from production
builds, documented in this plan.

## Auto-generated metadata defaults

### YouTube title template

Default: the story `hook` if it's ≤60 chars and ≥4 words, else
truncate the story `title` at 57 chars + "…". No boilerplate suffix.

Rationale: hooks are written hook-first which lands the focus keyword
in the first three words by accident.

### YouTube description template

```
{{hook}}

{{title}} — the full story, hand-drawn.

LoreWire turns the weirdest, most-argued-about stories on the internet
into one-minute hand-drawn shorts. This one is from our {{category}}
catalog.

📖 Read the full article: {{article_url}}
🔔 Subscribe for new shorts: https://www.youtube.com/@LoreWireHQ
🌐 lorewire.com

#Shorts #InternetStories #TrueStory #{{category}}Shorts #Reddit
```

Lands at ~180 words after substitution. Focus keyword in the first
sentence (the hook). Three CTAs ordered by retention value
(long-form article → channel subscribe → site).

### YouTube tags default

- Base set (global, comma-separated):
  `true stories, internet stories, lorewire, short stories, storytime`
- Per-category overrides under `publisher.youtube.tags.<category>`,
  e.g. `Drama → family drama, relationship stories`;
  `Entitled → entitled people, karma stories`;
  `Roommate → roommate stories, bad roommates`;
  `Dating → dating stories, dating drama`;
  `Humor → funny stories, comedy storytime`;
  `Wholesome → wholesome stories, faith in humanity`.
- Total budget: 8 tags after merge + dedupe, ≤500 chars combined
  (YouTube's hard cap).

### TikTok caption template

```
{{hook}}

The full story → {{article_url}}

#Shorts #TrueStory #InternetStories #{{category}}Stories #Reddit
```

~220 chars after substitution. Inside the 150–300 SEO sweet spot.
Focus keyword (the hook) lands in the first 50 chars window.

### Constants for both platforms

- `made_for_kids: false` (per user instruction)
- `synthetic / is_aigc: true` (per user instruction; accurate)
- Privacy default: `public` (YouTube) / `PUBLIC_TO_EVERYONE` (TikTok,
  verified against `creator_info` allowlist at publish time)
- TikTok branded toggles `disable_duet`/`disable_stitch`/
  `disable_comment` all default `false`; `brand_content_toggle` and
  `brand_organic_toggle` always `false` (LoreWire content is neither)
- YouTube `categoryId: "24"` (Entertainment)
- YouTube `defaultLanguage: "en"`
- YouTube SRT captions: upload via `captions.insert` after
  `videos.insert` succeeds, best-effort (failure logs but does not
  fail the row)

### TikTok handle

OPEN: Yoav to pick + claim a TikTok handle. The code is
handle-agnostic; only the OAuth refresh-token grant and the
defense-in-depth `TIKTOK_OPEN_ID` env var bind to a specific account.
Once Yoav has a handle and account, run the OAuth setup script and
paste tokens into Vercel.

## Admin Settings reorganization — Socials section

New left-nav tab in `SettingsShell`: **Socials**.

```
Settings / Socials
├── Instagram        (auto-publish toggle, caption template,
│                     ig_account_id readout, token status)
├── Facebook         (auto-publish toggle, caption template,
│                     fb_page_id readout, token status)
├── YouTube          (auto-publish toggle, title template,
│                     description template, tags base + per-category,
│                     privacy default, category default, MFK default,
│                     synthetic-media default, channel_id readout,
│                     OAuth status, SRT captions toggle)
├── TikTok           (auto-publish toggle, post_mode chip group
│                     (inbox/direct), caption template,
│                     hashtags base + per-category, privacy default,
│                     is_aigc default, duet/stitch/comment toggles,
│                     open_id readout, OAuth status,
│                     status badge: Sandbox (drafts) | Audited (direct))
└── Cross-platform   (poll-hook templates per platform, moved from
                      the Polls section since they're caption suffixes)
```

The existing FB + IG controls move out of "General" into "Socials".
The poll-hook block (currently in the polls section) moves too. Single
git pass, no behavior change for FB/IG/poll-hook.

## Per-short editing — manual publish buttons

Two new components on `/admin/shorts/[id]`, mirroring
`PublishToFacebookButton` and `PublishToInstagramButton`:

- `PublishToYouTubeButton` — shows the resolved title, description,
  tags, category, privacy, MFK, synthetic. Lets admin edit each
  before clicking publish. Edits don't change global defaults.
- `PublishToTikTokButton` — shows the resolved caption, hashtags,
  privacy (from creator_info), post_mode, is_aigc, duet/stitch/comment.
  Same edit-before-publish UX.

Both follow the FB/IG button's three states: idle → publishing →
result (posted with external URL link OR failed with error message
and a Retry button).

## Auto-publish wiring

`/api/render_short/route.ts` already calls
`publishShortToFacebookForRender` and `publishShortToInstagramForRender`
in fire-and-forget catch blocks after the render completes. Add two
more, identical shape:

```ts
await publishShortToYouTubeForRender(storyId, renderId, videoUrl, story)
  .catch(err => namespacedLog("youtube_publish_unhandled", { ... }));

await publishShortToTikTokForRender(storyId, renderId, videoUrl, story)
  .catch(err => namespacedLog("tiktok_publish_unhandled", { ... }));
```

Each `*ForRender` helper looks up the article URL the same way the FB
helper does, then dispatches to its platform publisher with
`trigger: 'auto'`.

## Retry crons

Two new `/api/retry_<platform>_publishes/route.ts` endpoints, identical
shape to `/api/retry_facebook_publishes` / `/api/retry_instagram_publishes`:

- Cron-triggered every N minutes.
- Selects `failed` (and TikTok also `pending` with `publish_id` set)
  rows whose `attempts < cap` and backoff has elapsed.
- Calls `attempt<Platform>PublishForRow(rowId)` for each.
- Idempotent on the row level (the publisher updates `attempts +1`
  even on success).

Add cron entries to `vercel.json`. Stagger by 1-minute offsets to
avoid all four crons stacking on the same minute.

## Security (rule 13)

- Every credential lives in env. Never logged. The token-fingerprint
  helper logs `has_token` + `token_len` only. Already a pattern in
  FB / IG modules — copy verbatim.
- Defense in depth: each platform module validates the account id
  returned by the platform's auth/me endpoint against the env var
  (`YOUTUBE_CHANNEL_ID`, `TIKTOK_OPEN_ID`). Mismatch → mark row failed
  with explicit "id mismatch" message. Refuses to upload to a
  different account than configured.
- OAuth scopes are minimum:
  - YouTube: `https://www.googleapis.com/auth/youtube.upload`. No
    read access to videos, comments, analytics.
  - TikTok: `video.upload video.publish user.info.basic`. No
    profile-edit, no inbox-read, no messaging.
- Token rotation runbooks (in this plan, kept up to date with code
  changes):
  - YouTube: revoke at `myaccount.google.com → Security → Third-party
    apps`. Re-run setup script. Update Vercel env. Redeploy.
  - TikTok: revoke at `tiktok.com/setting → Manage account →
    Apps and websites`. Re-run setup script. Update Vercel env.
    Redeploy.

## Observability (rule 14)

Logs at every meaningful step in each publisher, namespaced.

### YouTube

`[publish youtube <event>]` events: `attempt`, `oauth_refresh`,
`upload_start`, `upload_progress` (chunked uploads only),
`captions_upload_ok`, `captions_upload_skipped`,
`captions_upload_failed`, `ok`, `error`, `retry`, `deleted`.

Fields always logged: `story_id`, `render_id`, `trigger`, `channel_id`
last 6 chars, `latency_ms`. Token fingerprint on attempt only. On
`ok`: `external_video_id`. On `error`: `yt_reason`, `http_status`.

### TikTok

`[publish tiktok <event>]` events: `attempt`, `oauth_refresh`,
`creator_info_query`, `init`, `status_poll`, `ok`, `error`, `retry`,
`deleted`.

Fields always logged: `story_id`, `render_id`, `trigger`, `open_id`
last 6 chars, `post_mode`, `latency_ms`. Token fingerprint on attempt
only. On `init`: `publish_id`. On `status_poll`: `status_code`,
`poll_n`. On `ok`: `external_post_id`.

## Settings keys (rule 15)

### YouTube

```
publisher.youtube.auto_publish          ("0"/"1", default "0")
publisher.youtube.title_template        (text)
publisher.youtube.description_template  (text)
publisher.youtube.tags_base             (comma-separated text)
publisher.youtube.tags.<category>       (per-category, comma-separated)
publisher.youtube.category_id           (default "24")
publisher.youtube.privacy_default       (default "public")
publisher.youtube.made_for_kids         (default "0")
publisher.youtube.synthetic_media       (default "1")
publisher.youtube.upload_captions       (default "1")
```

### TikTok

```
publisher.tiktok.auto_publish           ("0"/"1", default "0")
publisher.tiktok.post_mode              ("inbox"/"direct", default "inbox")
publisher.tiktok.caption_template       (text)
publisher.tiktok.hashtags_base          (comma-separated text)
publisher.tiktok.hashtags.<category>    (per-category)
publisher.tiktok.privacy_default        (default "PUBLIC_TO_EVERYONE")
publisher.tiktok.is_aigc                (default "1")
publisher.tiktok.disable_duet           (default "0")
publisher.tiktok.disable_stitch         (default "0")
publisher.tiktok.disable_comment        (default "0")
```

The TikTok `post_mode` is the audit-gate switch. Flip from `inbox` to
`direct` the day audit clears. No code change.

## Testing (rule 18)

### Unit

- Caption / title / description template renders for every token
  combo + missing-token fallback. (Mirror `publish-to-facebook.test.ts`.)
- YouTube tag merging: base + per-category + dedupe + 500-char cap.
- YouTube title fallback chain: hook → title → story id.
- TikTok privacy_level whitelist filter against creator_info response.
- TikTok post_mode enum guard ("inbox"/"direct"/anything-else).
- Channel/open id mismatch defense (both platforms).
- Token-missing skip (both platforms).
- Auto-publish toggle off skip (both platforms).
- Dedup: existing pending/posted row for story skips auto trigger.

### Integration

Against a stubbed `googleapis` fake (YouTube) and stubbed `undici`
fetch (TikTok):
- YouTube happy path → row posted, external_video_id set.
- YouTube SRT sidecar upload succeeds + fails (best-effort).
- YouTube quota exhausted (HTTP 403 + reason='quotaExceeded') → row
  failed with that reason.
- YouTube auth refresh failure → row failed with refresh error.
- TikTok inbox happy path → row posted.
- TikTok direct happy path → row posted.
- TikTok async-poll FINISHED → row posted.
- TikTok async-poll FAILED → row failed.
- TikTok scope-not-granted (audit not cleared but post_mode=direct) →
  row failed with clear error.
- TikTok rate-limit 429 → retry cron picks up.

### Manual smoke

- Publish one short to YouTube with `privacy_default=unlisted` first.
  Verify in YouTube Studio that title/desc/tags/category/MFK/synthetic
  all landed correctly. Flip to public after.
- Publish one short to TikTok with `post_mode=inbox`. Verify it lands
  in the LoreWire TikTok app's Inbox with the right caption.

## Cost (rule 8)

- YouTube Data API: free. Default daily upload cap 100 videos/day.
  LoreWire's velocity is comfortably under.
- TikTok Content Posting API: free.
- No new LLM calls in this PR (template-based metadata). Phase 2's
  LLM-generated SEO metadata would add ~$0.001 per short (one
  cheap-model call) — negligible against the $0.70/short pipeline.
- No new infra. Reuses the existing Vercel cron pattern. Adds 2 cron
  entries to `vercel.json`.
- TikTok app audit: free. One-time effort 1–4 weeks. The existing
  `_plans/phase0-review-applications/tiktok-audit.md` covers the form.

## Phased rollout

1. Land this PR (drafts mode for TikTok, direct mode for YouTube).
2. Run the OAuth setup scripts locally, paste tokens into Vercel.
3. Smoke-test on preview with `privacy_default=unlisted` (YT) and
   `post_mode=inbox` (TT).
4. Flip YT toggle on in production.
5. Submit TikTok app audit.
6. Once audit clears, flip `publisher.tiktok.post_mode` from `inbox`
   to `direct` in production settings. No code change.

## Phase 2 (out of scope)

LLM-generated SEO metadata produced once per short in the pipeline,
persisted on the story row, consumed by all four publishers as richer
tokens (`{{seo_title}}`, `{{seo_description}}`, `{{seo_tags}}`). Adds
smarter copy at marginal cost. Deferred so this PR stays focused.

## Open items

1. TikTok handle — Yoav to pick, claim, and grant OAuth.
2. Vercel env vars (YT × 4, TT × 4) — Yoav to add after the OAuth
   setup scripts produce the refresh tokens.

## Verification sources

- YouTube Data API v3 — videos.insert (official):
  https://developers.google.com/youtube/v3/docs/videos/insert
- TikTok Content Posting API — Direct Post Reference (official):
  https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
- TikTok Content Posting API — Inbox / Upload (official):
  https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content
- YouTube Shorts SEO 2026 — CRKLR, Crawlvision, SEO Sherpa
- TikTok SEO 2026 — SocialMediaEnthusiasts, Graphicwise, Hootsuite
