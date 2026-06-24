# Instagram auto-publish for LoreWire shorts

Date: 2026-06-24
Branch: `feat/instagram-auto-publish` (off `feat/multi-platform-shorts-publisher`)
Status: Ready to implement
Cross-ref: `_plans/2026-06-23-facebook-auto-publish.md` (the parent pattern)

## Goal

When a short finishes rendering, also publish it as an **Instagram Reel** to the LoreWire IG Business Account (`17841413922168686`), with the same caption template as Facebook. Mirrors the Facebook auto-publish architecture; this doc focuses only on what's *different* from FB. For the unchanged bits (best-effort hook, status table, retry cron pattern, settings UI shape, manual button), see the FB plan.

## What's different from Facebook (the load-bearing list)

### 1. Two-step API flow (vs FB's single-step)

Posting a Reel is two requests with an async wait in between:

```
1. POST https://graph.instagram.com/v22.0/{ig-id}/media
     ?media_type=REELS
     &video_url=<gcs-url>
     &caption=<rendered-caption>
     &access_token=<page-token>
   → returns { id: "<container-id>" }

2. Poll GET https://graph.instagram.com/v22.0/{container-id}?fields=status_code
   → until status_code == "FINISHED" (typical: 10–30s for our 5–10MB shorts)
   → if "ERROR", abort with the error
   → if still "IN_PROGRESS" after our timeout, defer to the retry cron

3. POST https://graph.instagram.com/v22.0/{ig-id}/media_publish
     ?creation_id=<container-id>
     &access_token=<page-token>
   → returns { id: "<external-post-id>" }
```

Implication for the data model: we need a `container_id` column. If the publish route times out between steps 2 and 3, the retry cron resumes from where it left off using the stored `container_id` (skip step 1 entirely).

### 2. Different host

`graph.instagram.com` (NOT `graph.facebook.com` or `graph-video.facebook.com`). Easy to mis-copy from the FB module — keep the const distinct.

### 3. `media_type=REELS` is required for vertical video

Without it, IG treats the post as a regular video which gets less reach and shows up differently in the feed. Our shorts are 9:16, so REELS is correct.

### 4. Caption length cap: 2200 chars

FB allows ~63k; IG caps at 2200. If the rendered caption exceeds 2200, truncate with a trailing `…`. The render is shared with FB so the source caption is the same — only the trim differs.

### 5. Rate limit: 100 posts per 24 hours

Lower than FB's effectively-unlimited. Far above LoreWire's expected volume (1–10/day), but worth logging the `content_publishing_limit` field for observability.

### 6. Credential reuse

**No new token needed.** The existing `FB_PAGE_ACCESS_TOKEN` works for IG because the LoreWire IG Business Account is linked to the LoreWire Facebook Page in Meta Business Suite. The Graph API recognises the same Page token as having authority over the linked IG account, given the scopes we declared.

Only new env var: **`IG_BUSINESS_ACCOUNT_ID=17841413922168686`** (Production + Preview + Development in Vercel).

### 7. New permissions on the token

Added to the LoreWire Publisher Meta app:
- `instagram_basic`
- `instagram_content_publish` (or `instagram_content_publishing` — Meta uses both names)

These are declared, not App-Reviewed. Standard Access works for the LoreWire IG account because we own it.

## Approach

### Files

New:
- `lorewire-app/src/lib/publish-to-instagram.ts` — mirrors `publish-to-facebook.ts`. Exports `publishShortToInstagram`, `attemptInstagramPublishForRow`, `deleteLatestPostedRowForStory` (the IG variant).
- `lorewire-app/src/lib/publish-to-instagram.test.ts` — mirrors the FB test suite, plus 2-step-flow-specific tests (container created but poll times out, container errored, status_code transitions).
- `lorewire-app/src/app/api/retry_instagram_publishes/route.ts` — mirrors the FB retry route. Adds a small twist: rows that have a `container_id` but no `external_post_id` skip step 1 and resume from step 2 (resume polling) or step 3 (publish directly if container is FINISHED).
- `lorewire-app/src/app/api/retry_instagram_publishes/route.test.ts`

Edited:
- `lorewire-app/src/lib/schema.ts` — add `INSTAGRAM_POSTS` table to `TABLES`.
- `lorewire-app/src/app/api/render_short/route.ts` — call `publishShortToInstagramForRender(...)` in parallel with the existing FB call, both best-effort.
- `lorewire-app/src/app/admin/(panel)/settings/page.tsx` — add "Social publishing — Instagram" section right under the FB one.
- `lorewire-app/src/app/admin/(panel)/shorts/[id]/actions.ts` — add `publishToInstagramAction` + `getLatestInstagramPostForStoryAction` (mirror of the FB versions).
- `lorewire-app/src/app/admin/(panel)/shorts/[id]/PublishToInstagramButton.tsx` — new, mirrors `PublishToFacebookButton`.
- `lorewire-app/src/app/admin/(panel)/shorts/[id]/ShortEditorClient.tsx` — mount the IG button next to the FB one.
- `lorewire-app/src/app/admin/(panel)/shorts/[id]/page.tsx` — fetch `latestInstagramPost` in parallel with the FB lookup.
- `lorewire-app/vercel.json` — add `/api/retry_instagram_publishes` cron (every 5 min) and `maxDuration` entry.

### Data model

`instagram_posts` table (mirrors `facebook_posts` with IG-specific columns):

```
id                text primary key      -- uuid
story_id          text not null
render_id         text                  -- nullable for manual re-posts on older shorts
ig_account_id     text not null         -- IG_BUSINESS_ACCOUNT_ID at post time (audit)
trigger           text not null         -- 'auto' | 'manual'
video_url         text not null
caption           text not null         -- already truncated to 2200 chars at insert
container_id      text                  -- step-1 result; populated even on failed step-2 polls so retry can resume
status            text not null         -- 'pending' | 'posted' | 'failed' | 'deleted'
external_post_id  text                  -- step-3 result (the published Reel id)
ig_error_code     integer
ig_error_subcode  integer
error_message     text
attempts          integer not null default 0
created_at        timestamptz not null default now()
posted_at         timestamptz
deleted_at        timestamptz
```

### Inline polling strategy (step 2)

After creating a container, poll up to **30 seconds** with a 2-second interval. Three outcomes:

- `FINISHED` → proceed to step 3 (publish). Update row → `posted` with `external_post_id`.
- `ERROR` → mark row `failed` with the IG error. Retry cron will NOT re-try a known-bad container; it would just hit the same error.
- Still `IN_PROGRESS` after 30s → mark row `pending` (note: NOT `failed`), keep `container_id` set, return. The retry cron picks it up and resumes polling.

Why 30s and not 60s: keeps the parent render route under the 800s Vercel cap with headroom even if Cloud Run also runs long. Most LoreWire shorts at 5–10MB finish IG processing in 10–20s based on Meta's documented behavior for similar sizes; 30s catches the long tail without being a hard upper bound.

### Caption truncation

```ts
const IG_CAPTION_LIMIT = 2200;
function trimForIg(s: string): string {
  if (s.length <= IG_CAPTION_LIMIT) return s;
  return s.slice(0, IG_CAPTION_LIMIT - 1) + "…";
}
```

The same caption template feeds both FB and IG; truncation happens at the IG boundary, not in the template. This keeps the template authoritative and the platform-specific limits at the edge.

### Render-route wiring

```ts
// after finishShortRender + segment stamp + FB publish hook:
await publishShortToInstagramForRender(claimed.story_id, claimed.id, result.url, story).catch(...)
```

Best-effort with `.catch()` swallowing — same pattern as the FB hook. The two publishes run sequentially (FB first, then IG), each independently gated by its own toggle. Sequential vs parallel: chose sequential for log readability and to make the order deterministic during incident triage. If either platform's failure scopes broadly, the next render's hook still fires independently.

## Security (rule 13)

- `FB_PAGE_ACCESS_TOKEN`: same env var, never logged.
- `IG_BUSINESS_ACCOUNT_ID`: env var (not in DB). Mirrored as display-only in settings.
- `publish-to-instagram.ts` is `import "server-only"`.
- Page-id mismatch check defends against accidental cross-account posting: the publish call refuses if `ig_account_id !== env.IG_BUSINESS_ACCOUNT_ID`.
- Logs use `[publish instagram *]` namespace, structured fields, token fingerprint (length only).

## Observability (rule 14)

Namespace: `[publish instagram *]`.

Events:
- `[publish instagram attempt]` `{ story_id, render_id, trigger, ig_account_id, video_url_host, caption_len, caption_truncated, has_token, token_len }`
- `[publish instagram container_created]` `{ story_id, render_id, container_id, latency_ms }`
- `[publish instagram container_poll]` `{ story_id, render_id, container_id, status_code, poll_n, elapsed_ms }`
- `[publish instagram container_timeout]` `{ story_id, render_id, container_id, polls, elapsed_ms }` — defers to retry cron
- `[publish instagram ok]` `{ story_id, render_id, trigger, external_post_id, total_latency_ms }`
- `[publish instagram error]` `{ story_id, render_id, trigger, ig_error_code, ig_error_subcode, ig_message, ig_trace, latency_ms }`
- `[publish instagram skipped]` `{ story_id, render_id, reason }`
- `[publish instagram retry]` `{ story_id, render_id, attempt, resume_from }` — `resume_from` is `'container'` (skip step 1) or `'publish'` (container FINISHED, just publish)
- `[publish instagram deleted]` `{ story_id, external_post_id, latency_ms }`

## Testing (rule 18)

Vitest, colocated `publish-to-instagram.test.ts`. Mirrors the FB test cases (1–10) plus IG-specific:

11. Container creation succeeds but poll returns IN_PROGRESS past timeout → row left in `pending` with `container_id` set.
12. Container poll returns ERROR → row marked `failed`, NO retry.
13. Caption truncated when > 2200 chars; truncation flag in log.
14. Retry resumes from `container_id` without re-creating (verify only 1 fetch call to /media, the rest to status + publish).
15. Page-id mismatch check refuses to publish.

Retry route tests mirror the FB retry route (auth, backoff math, drain happy path, cap exclusion, too-recent filter) plus:
16. Row with `container_id` and `status='pending'` is eligible for retry even without backoff elapsed (it's not a failed-retry, it's a resume).

## Settings audit (rule 15)

New section in admin Settings: **Social publishing — Instagram** (right under Facebook).

Controls:
- `publisher.instagram.auto_publish` (`SettingToggle`, default OFF, ships dark)
- `publisher.instagram.caption_template` (`SettingText`) — separate from FB so future divergence is easy. Default mirrors the FB template; admin can edit either independently.
- Display-only: "LoreWire IG (id: 17841413922168686)" + "Page Access Token: ✓ configured (env)".

Intentionally NOT exposed:
- `IG_BUSINESS_ACCOUNT_ID` (env-only, display-only in settings)
- `FB_PAGE_ACCESS_TOKEN` (env-only)
- Container polling cadence / timeout (wired in code)

## Cost (rule 8)

- Graph API: free.
- GCS egress: Meta pulls the video once per post (same as FB). Doubles the egress vs FB-only (Meta fetches it for FB AND for IG separately). Still ~$0.0012/post for our 5–10MB shorts. Negligible.
- Vercel cron: existing Pro plan. One new entry in vercel.json.

## Decisions (carried forward from FB plan + IG-specific)

1. **Independent toggle** from FB. Admin can have FB on, IG off (or vice versa).
2. **Story-level dedup** on auto path (no re-render = no re-post). Manual re-publish bypasses.
3. **Delete-previous on manual re-publish** supported via `DELETE /{ig-post-id}`.
4. **Sequential not parallel** for FB+IG publishes in the render hook (log readability + simpler incident triage).
5. **Caption template separate from FB**, both default to the same string, but stored independently so admin can edit either without affecting the other.
6. **30s container polling timeout** inline, then defer to retry cron.

## Out of scope

- Stories / Carousel / IGTV — Reels only.
- IG comment moderation via API.
- IG insights (post reach, plays, etc.) pulled back into admin.
- Tagging users in posts.

## Implementation order

1. Migration: `instagram_posts` table in schema.
2. `publish-to-instagram.ts` + tests (mocked HTTP). Land green.
3. Wire into `render_short/route.ts` behind toggle.
4. Settings UI.
5. Manual button + action + page wiring.
6. Retry cron + tests + vercel.json.
7. Run full test suite + type-check.
8. Commit + push + PR to `feat/multi-platform-shorts-publisher`.

## Verification before done

- Vitest green (+25 new tests).
- TypeScript clean.
- Manual: one short renders with toggle ON → one Reel appears on LoreWire IG.
- Toggle OFF → no Reel.
- Manual button: works for both publish and re-publish (with delete-previous).
- Force 4xx via bad token → row lands in `failed`, retry cron picks it up after env var fix.
- Container timeout: render a longer/larger short → row lands in `pending` with `container_id`, retry cron drains it within the next 5-minute window.

## Git workflow (per AGENTS.md)

- Branch off `origin/feat/multi-platform-shorts-publisher` (production-source) ✓ done.
- PR targets `feat/multi-platform-shorts-publisher`, NOT main.
- After Vercel preview green + smoke test, merge via GitHub (NOT manual Vercel promote).
