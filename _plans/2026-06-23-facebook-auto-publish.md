# Facebook auto-publish for LoreWire shorts

Date: 2026-06-23
Branch: (new, off `main`) — suggested `feat/facebook-auto-publish`
Status: Approved, ready to implement

## Goal

When the shorts pipeline finishes rendering a short to GCS, auto-publish that short as a video post on the **LoreWire** Facebook Page (`page_id=911708085365160`), with a hook-first caption and a link back to the underlying article.

That's it. One page, one credential, one direction. No user-facing Facebook Login. No App Review. No fan-out to other people's pages.

## Why now

Meta App Review for the existing LoreWire Meta app approved `public_profile` and `email` for user login. Those scopes are unused for this goal — auto-posting to our own Page needs the `pages_*` permissions instead. A second Meta app ("LoreWire Publisher") was created with the **Manage everything on your Page** use case, and a **never-expiring Page Access Token** was minted for the LoreWire Page on 2026-06-23. The credential is in hand; what's left is wiring the publish call into the shorts pipeline.

## Constraints and known risks

- **The credential is a long-lived Page Access Token in an env var.** No refresh dance. No OAuth flow at runtime. If the token is ever rotated (admin role change, manual revoke), the env var has to be updated manually.
- **Meta's fetcher throttles `storage.googleapis.com`.** Meta frequently fails fetches from raw GCS public URLs. We may need a fronting URL via the lorewire.com domain or a GCS signed URL. Plan for both, ship with raw GCS first, instrument enough to detect the failure mode and pivot.
- **Facebook video processing is async on their side.** The API responds with a `video_id` within seconds, but the post is "processing" until Facebook finishes encoding (minutes for short clips). We treat the initial 200-with-id as success and don't wait.
- **Standard Access only.** This integration acts only on the LoreWire Page where Yoav is an admin on both the app and the page. It will silently break if we ever try to point it at a page outside that constraint.
- **Idempotency matters.** The render cron can fire twice on the same row. Posting the same short twice to the Page would be visibly bad. We enforce dedup at story level in application code.
- **Next.js note.** `lorewire-app/AGENTS.md` flags that this fork has breaking changes; the implementer must read `node_modules/next/dist/docs/` before adding any new route handler.

## Requirements

Functional:

1. Every short that successfully renders to GCS gets posted to the LoreWire Page within a few minutes of the render finishing — provided the master toggle is on and the story has not been posted before.
2. Caption defaults to the short's hook + article URL, customizable via a single template in admin Settings.
3. Failures don't break the render pipeline. A failed post is a row in a queue table that a retry cron picks up later.
4. The Page-token credential lives only in server-side env vars. Never in the DB, never in logs, never in client bundles.
5. The admin can see whether a given short was posted to Facebook (and when, and the FB post ID linking to it).
6. The admin can manually publish or re-publish a short to Facebook from the short editor, including an optional "delete previous Facebook post first" path.

Non-functional:

- All logs use the existing `[namespace event]` JSON pattern (`namespacedLog` style from `render_short/route.ts:48`).
- Tests use Vitest, collocated `*.test.ts`, mocked HTTP — matching `publish-auto-curate.test.ts`.
- All new code is `import "server-only"` because it touches the Page Access Token.

## Approach

Best-effort post-render hook, modeled on `publish-auto-curate.ts`. Same shape (swallow errors, log structured fields, never bubble up to the parent flow), different downstream call.

### Trigger point

After `finishShortRender(claimed.id, result.url)` succeeds in `lorewire-app/src/app/api/render_short/route.ts:241`. Add a `publishShortToFacebook(...)` call right after the segment-stamp call. Best-effort, awaited, but wrapped in `.catch()` so a Facebook failure cannot block the render route's response.

### Files

New:

- `lorewire-app/src/lib/publish-to-facebook.ts` — the post call, retry-aware status writes, error normalization. Mirrors `publish-auto-curate.ts` shape.
- `lorewire-app/src/lib/publish-to-facebook.test.ts` — Vitest unit tests.
- `lorewire-app/src/app/api/retry_facebook_publishes/route.ts` — Vercel cron drain, retries failed `facebook_posts` rows with exponential backoff. Mirrors the auth + advisory-lock pattern from `render_short/route.ts`.
- `lorewire-app/src/app/api/manual_facebook_publish/route.ts` — POST route the short editor calls to trigger a manual (re-)publish, with optional delete-previous.
- `lorewire-app/drizzle/NNNN_facebook_posts.sql` — migration for the new tracking table.

Edited:

- `lorewire-app/src/app/api/render_short/route.ts` — insert one `publishShortToFacebook(...)` call after the segment stamp at line 247.
- `lorewire-app/src/lib/schema.ts` — register the new `facebook_posts` table.
- `lorewire-app/src/app/admin/(panel)/settings/page.tsx` — add the "Social publishing → Facebook" section.
- `lorewire-app/vercel.json` — add the new cron entry for `retry_facebook_publishes`.
- (Short editor component) — add the manual publish button + confirm modal.

### Data model

New table `facebook_posts`:

```
id                text primary key       -- uuid
story_id          text not null          -- fk to stories.id
render_id         text                   -- fk to short_renders.id, NULL for manual re-posts on an older render
page_id           text not null          -- FB page id at post time (for audit)
trigger           text not null          -- 'auto' | 'manual'
video_url         text not null          -- the GCS url we handed to Facebook
caption           text not null          -- the rendered caption text
status            text not null          -- 'pending' | 'posted' | 'failed' | 'deleted'
external_post_id  text                   -- FB video_id, populated on success
fb_error_code     integer                -- populated on failed FB call
fb_error_subcode  integer
error_message     text
attempts          integer not null default 0
created_at        timestamptz not null default now()
posted_at         timestamptz
deleted_at        timestamptz            -- set when manual flow deletes a previous post
```

No DB-level unique constraint. Dedup is application-level so manual re-publish can stack rows freely on the same `story_id` / `render_id`.

### Endpoint and call shape

```
POST https://graph-video.facebook.com/v22.0/911708085365160/videos
Content-Type: application/x-www-form-urlencoded

access_token={FB_PAGE_ACCESS_TOKEN}
file_url={gcs_video_url}
description={rendered_caption}
title={short_title_or_omit}
```

Success response: `{ id: "...", success: true }` — store `id` as `external_post_id`.

Failure: Facebook returns `{ error: { code, error_subcode, message, fbtrace_id } }`. Normalize into the table columns and log the full error body once.

For the "delete previous" path:

```
DELETE https://graph.facebook.com/v22.0/{external_post_id}
?access_token={FB_PAGE_ACCESS_TOKEN}
```

On success, flip the previous row's `status` to `deleted` and stamp `deleted_at`. Then proceed with the new publish. If the delete fails, log the error and DO NOT publish the new one — surface to the admin so they can decide.

### Caption template

Stored in `settings` table as `publisher.facebook.caption_template`. Default:

```
{{hook}}

📖 Read the full story: {{article_url}}
```

Tokens: `{{hook}}`, `{{article_url}}`, `{{title}}`. Rendered at publish time. Substitution rules:

- `{{hook}}` missing → substitute the article title.
- `{{title}}` missing → substitute the story id (last-resort, should never happen).
- `{{article_url}}` missing → substitute the lorewire.com homepage URL.

### Failure and retry

Inline attempt happens immediately after render. On failure:

- Insert row with `status='failed'`, `attempts=1`, error fields populated.
- Log `[publish facebook error]` with the structured FB error fields.
- Do not throw — the parent render route returns 200 with the render id as it would otherwise.

The retry cron (`/api/retry_facebook_publishes`, every 5 minutes) selects `status='failed' AND attempts < 5`, with `now() > created_at + interval '1 min' * power(2, attempts)` for exponential backoff (1 / 2 / 4 / 8 / 16 min). On success it flips status to `posted` and stamps `posted_at` + `external_post_id`. After 5 attempts it stays `failed` and a human investigates — surfaced in the admin dashboard.

The retry cron runs regardless of the master toggle state (Option A from the decisions below), so an outage + brief toggle-off doesn't strand work.

### Trigger gating

`publisher.facebook.auto_publish` setting toggles the auto path. Default `false` (opt-in). When off, the render route does nothing Facebook-related — no row written, no API call. The manual publish button and the retry cron are NOT gated by this toggle.

This means the integration can ship dark and be enabled by flipping one toggle in admin.

### Manual publish / re-publish flow

The short editor page exposes a button on each short:

- If no `facebook_posts` row exists for this story: button reads **"Publish to Facebook"**.
- If a `posted` row exists: button reads **"Re-publish to Facebook"**.
- If a `pending` or `failed` row exists: button reads **"Retry Facebook publish"**.

Clicking opens a confirm modal:

- Caption preview (rendered from the current template, editable inline for one-off overrides — the edited version is stored in the new row's `caption` column, doesn't update the global template).
- For re-publish: a checkbox **"Delete previous Facebook post first"** (default: off), with helper text *"This removes the prior post from the LoreWire Page before publishing the new one. Use after fixing a typo or for a content takedown."*

Submit → POST to `/api/manual_facebook_publish` with `{ story_id, caption_override?, delete_previous: boolean }`. The route:

1. Validates admin auth (existing admin session).
2. If `delete_previous`: looks up the most recent `posted` row for this story, calls `DELETE /{external_post_id}`, flips that row to `deleted` on success. On delete failure, returns 500 and does NOT proceed.
3. Inserts a new `pending` row with `trigger='manual'`.
4. Invokes the same `publishShortToFacebook(...)` function inline, awaited.
5. Returns the new row's terminal state (`posted` with `external_post_id`, or `failed` with error message).

The short editor shows the result inline (no page refresh needed).

## Alternatives rejected

1. **Inline await with retry in the render route.** Would couple Facebook API latency and failure modes to render success. Rejected: a Facebook outage would start failing the entire shorts pipeline. The best-effort + queue approach is cleaner.

2. **Resumable / multipart upload of the MP4 bytes from our backend.** Avoids the `storage.googleapis.com` throttle risk. Rejected for v1 — heavier code, longer Vercel route runtime, more bandwidth cost. Keep as the fallback if file_url proves unreliable in production.

3. **Storing the Page Access Token in the DB so admin can rotate it without redeploying.** Rejected: per rule 13, treat the token like a database password. Env var only. If rotation matters, that's a Vercel env var change, which is fast enough.

4. **Wait for Facebook video processing to complete before marking posted.** Rejected: processing time is variable (1–10 minutes) and Facebook returns the post URL immediately. Adds polling complexity for no user-visible benefit.

5. **Auto-publish to Instagram Reels in the same change.** Rejected for scope reasons — IG needs its own setup (Instagram Business Account linkage to the Page, separate API). Plan it as a follow-up using the same publisher pattern.

6. **DB-level unique constraint on `(story_id)` or `(render_id)`.** Rejected because manual re-publish needs to stack rows on the same story. Dedup moves to application code (auto path checks for existing pending/posted rows before inserting).

## Security (rule 13)

- `FB_PAGE_ACCESS_TOKEN`: server-only env var. Added to Vercel project (Production + Preview + Development), not committed, not in client bundle.
- `FB_PAGE_ID`: same. Even though it's not a secret, env-driven config means we can point a staging deploy at a test page without code changes.
- `publish-to-facebook.ts` begins with `import "server-only"` so a Webpack misimport into a Client Component fails the build immediately.
- The Page Access Token is **never logged**. Logs include `has_token: Boolean(env.FB_PAGE_ACCESS_TOKEN)` and `token_len: env.FB_PAGE_ACCESS_TOKEN?.length ?? 0` — enough to debug "did we have a credential at all" without leaking it.
- The publish call validates `page_id === env.FB_PAGE_ID` before posting — defense against a future refactor accidentally letting per-row data control which Page we post to.
- Manual publish route requires admin auth (existing admin session, not a public route).
- Token rotation runbook: revoke at facebook.com/settings → Business Tools → LoreWire Publisher → Remove, redo OAuth + `/me/accounts` dance, update Vercel env var, redeploy. ~5 minutes.

## Observability (rule 14)

Namespace: `[publish facebook *]`. JSON-stringified field bag matching `namespacedLog` from `render_short/route.ts:48`.

Events:

- `[publish facebook attempt]` `{ story_id, render_id, trigger, page_id, video_url_host, caption_len, has_token, token_len }` — every attempt, before the network call.
- `[publish facebook ok]` `{ story_id, render_id, trigger, external_post_id, latency_ms }`.
- `[publish facebook error]` `{ story_id, render_id, trigger, fb_error_code, fb_error_subcode, fb_message, fb_trace, latency_ms }`.
- `[publish facebook skipped]` `{ story_id, render_id, reason }` — toggle off, missing config, duplicate story, etc.
- `[publish facebook retry]` `{ story_id, render_id, attempt }` — from the retry cron.
- `[publish facebook deleted]` `{ story_id, external_post_id, latency_ms }` — from the delete-previous path.

The `video_url_host` field (not the full URL) is enough to confirm whether Meta is fetching from raw GCS or a fronting domain, without leaking signed-URL tokens.

## Testing (rule 18)

Framework: Vitest. File: `publish-to-facebook.test.ts`.

Unit tests (mock `undiciFetch` or `fetch`):

1. Happy path — valid env, story not yet posted, Facebook returns 200 with `id`. Asserts a `posted` row was written with `external_post_id`.
2. Missing token env — function returns early with `status='skipped'`, no DB write, no HTTP call.
3. Auto-publish toggle off — auto path returns early, no DB write, no HTTP call. Manual path proceeds.
4. Story already posted (auto path) — returns skipped, no duplicate row.
5. Facebook 4xx with `fb_error_code=190` (invalid token) — row written with `status='failed'`, error fields populated, log emitted.
6. Facebook 5xx — same shape, retry-eligible.
7. Caption template — `{{hook}}` and `{{article_url}}` substitutions render correctly with non-trivial inputs (multi-line hook, Unicode emoji, missing hook falls back to title).
8. Page id mismatch — refuses to post if `page_id !== env.FB_PAGE_ID`.
9. Manual re-publish with delete_previous=true — calls DELETE first, flips old row to `deleted`, proceeds with new publish.
10. Manual re-publish with delete_previous=true but DELETE fails — does NOT proceed with new publish, returns failed state.

Retry cron tests:

11. Backoff math — `attempts=0` is eligible immediately, `attempts=1` after 1min, etc.
12. Cap — `attempts >= 5` stays failed and isn't retried.
13. Success after retry — row flips from `failed` to `posted` with new `posted_at`.

Manual smoke test (run after first deploy to preview):

- Toggle on the setting.
- Trigger one short render.
- Verify the post appears on the LoreWire Facebook Page within a few minutes.
- Verify the `facebook_posts` row reflects `status='posted'` with a real `external_post_id`.
- Disable the toggle, render another short, verify no post.
- Click manual "Publish to Facebook" on a story that was never auto-published — verify it posts.
- Click "Re-publish to Facebook" with delete-previous unticked — verify two posts on Page.
- Click "Re-publish to Facebook" with delete-previous ticked — verify previous removed, new posted.

## Settings audit (rule 15)

New section in `admin/(panel)/settings/page.tsx`: **Social publishing → Facebook**.

Controls:

- `publisher.facebook.auto_publish` — `SettingToggle`. Default: **off**. Why off: shipping dark, enable after smoke test in production.
- `publisher.facebook.caption_template` — `SettingText` (multi-line). Default: hook + article URL template above.
- `publisher.facebook.page_name` — display-only label showing "LoreWire (page_id 911708085365160)" so the admin can see which page they're configured for without exposing the token.

Intentionally NOT exposed as settings:

- `FB_PAGE_ACCESS_TOKEN` — env var only, see security section.
- `FB_PAGE_ID` — env var only, but mirrored display-only in settings for visibility.
- Retry cadence — wired into code, not user-facing.

Future considerations (logged here, out of scope for this PR):

- Per-short "skip auto-publish" override checkbox in the short editor (default: respect global toggle).
- Scheduled-publish-time field on the post (Facebook supports it via `scheduled_publish_time`). Useful for queueing to peak hours.
- A "first comment with article link" auto-comment (engagement hack — Facebook deprioritizes posts with links in body text, but link in a first comment doesn't penalize reach).

## Cost (rule 8)

- Facebook Graph API: **free** for posting to a Page you own. No per-call cost.
- GCS egress: ~$0.12/GB per Meta fetch. Our shorts are ~5–10 MB. Per published short: under one cent. Over a year of daily publishes: under $5.
- Vercel cron: existing Pro plan, no additional cost. The retry cron is one extra entry in `vercel.json`, well within the plan's cron quota.

No surprise costs anywhere in this design.

## Resolved decisions (2026-06-23)

1. **Auto-publish dedupes at story level.** A re-render does NOT re-post. Gate on `(SELECT COUNT(*) FROM facebook_posts WHERE story_id = ? AND status IN ('pending','posted')) = 0` before the auto path inserts.

2. **Manual re-publish from the short editor.** Bypasses the toggle and the story-level dedup. Supports an optional "Delete previous Facebook post first" checkbox that calls `DELETE /{external_post_id}` before publishing the new one.

3. **Caption fallback.** Missing hook → substitute the article title.

4. **Toggle-off semantics (Option A).** Master toggle off ⇒ no NEW auto-publish attempts. The retry cron continues to drain previously-failed rows so an outage + brief toggle-off doesn't strand work.

5. **Instagram: follow-up PR.** Out of scope for this change.

## Out of scope

- Posting to other people's Pages (would require App Review for Advanced Access).
- Posting on behalf of end users who log in with Facebook (the existing LoreWire app's `public_profile` + `email` approval is reserved for that future feature; leave the app alone, don't repurpose).
- Reading engagement metrics (likes, comments, shares) back into LoreWire.
- Comment moderation via API. The token has `pages_manage_engagement` but that capability isn't wired in this PR.
- Instagram Reels.

## Implementation order

1. Migration: create `facebook_posts` table.
2. `publish-to-facebook.ts` core function + unit tests (mocked HTTP). Land in green.
3. Wire into `render_short/route.ts` behind the toggle. Manual smoke test on preview.
4. Settings UI section.
5. Manual publish route + short-editor button + confirm modal.
6. Retry cron route + tests + `vercel.json` entry.
7. Deploy to preview, toggle on, watch one render through end-to-end.
8. Promote to production. Toggle stays off until verified there.

## Verification before calling this done

- Vitest suite green: `cd lorewire-app && npm test`.
- TypeScript clean: `cd lorewire-app && npm run type-check` (or whatever the script is — verify before relying).
- Manual: one short renders → one Facebook Page post appears → `facebook_posts` row in `posted` state.
- Toggle off + render → no post, no row.
- Manual publish + manual re-publish (both with and without delete-previous) all work as designed.
- Force a 4xx (rotate the env var to a bad value, render, watch the row land in `failed`, watch the retry cron pick it up after the env var is fixed).

## Git workflow notes (per AGENTS.md)

Per the lorewire AGENTS.md hardened rules (which document three production takedowns in the last 48 hours):

- Branch `feat/facebook-auto-publish` off **the current Vercel Production Branch**, not main, until main catches up to production.
- Before pushing, run the divergence check against the production-source branch listed in AGENTS.md.
- Do NOT merge to main without confirming main is current with production.
- Do NOT manually promote the resulting preview to production in the Vercel UI — let auto-deploy do its job from the production-source branch.

Confirm the current Vercel Production Branch with Yoav before creating the feature branch.
