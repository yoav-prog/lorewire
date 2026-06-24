# 2026-06-25 — Cross-post rendered Reel as Story on Instagram + Facebook

## Goal

When a short finishes rendering and we successfully auto-publish it as a Reel
on Instagram and as a Reel-style video on Facebook, **also** publish the same
vertical MP4 as a Story to each platform. One render → up to four artifacts
per Meta surface (IG Reel, IG Story, FB Reel, FB Story), each gated by its
own admin toggle.

The Reel remains the discovery surface. The Story is a presence play: it
parks LoreWire at the top of every follower's feed for 24 hours at near-zero
incremental engineering cost, since the rendered asset + auth + the
adapter pattern already exist.

## Goals, constraints, requirements

### What success looks like

- Two new admin toggles (one per platform), default OFF, that gate the
  Story cross-post.
- When ON: every successful Reel publish queues a Story publish of the
  same MP4 to the same surface. Failures land in their own per-platform
  table with a retry cron, same shape as Reels.
- Manual republish from the short editor can fire Stories independently
  of the auto path (same dual-trigger model as Reels).
- No new env vars. Story publishing reuses `FB_PAGE_ACCESS_TOKEN`,
  `IG_BUSINESS_ACCOUNT_ID`, `FB_PAGE_ID`. (Verified: the existing
  `instagram_content_publish` and `pages_manage_posts` scopes cover the
  Story endpoints. No new App Review.)

### Constraints

- **No clickable links via API.** Story link stickers are creation-tool
  only. The CTA the user sees in the Story is "go check our profile",
  not a swipe-up to the article. We accept this and frame the surface as
  presence, not traffic.
- **24-hour ephemerality.** Insights window closes at +24h. We do not
  pull Story analytics in this PR — defer until Reels analytics are
  in. The DB row still records `external_post_id` and `posted_at` so
  later analytics work has a key to query against.
- **No captions on Stories.** Both IG Stories (`media_type=STORIES`)
  and FB Stories (`/video_stories`) reject caption/description on
  creation. We skip the caption resolution chain entirely — schema has
  no caption column.
- **Cost: $0.** Both endpoints are free Graph API calls. The
  per-account 100/24h Content Publishing Limit on IG covers ALL
  publishes (Reels + Stories share the bucket). At LoreWire's current
  cadence (≤5 shorts/day) we are nowhere near the cap. Track it; do
  not gate.
- **No promotion to production from this PR.** Lorewire is still in
  the inverted Vercel state per AGENTS.md (`feat/multi-platform-shorts-publisher`
  is the production-source branch, and the YT/TT branch is behind main
  by many commits). This PR targets
  `feat/youtube-and-tiktok-auto-publish`, lands as a preview, and only
  ships once main catches up and the inverted state is unwound. The PR
  is dormant until then.

### Out of scope

- Story-specific rendering (separate 15s teaser cut). Cross-posting the
  full Reel MP4 is the cheap path; refine if metrics justify.
- Story link stickers (API does not allow programmatic stickers).
- Story analytics ingestion.
- Threads / X cross-post (separate plan, separate PR).

## Chosen approach — Option A: cross-post the Reel MP4 as a Story

After each successful Reel publish in `render_short/route.ts`, fire a
Story publish of the same `videoUrl` to the same surface. Sequential,
not parallel, to keep logs readable and incident triage simple
(matches the existing FB→IG sequencing).

### Why this won over Options B and C

- **Option B (Story-specific teaser cut):** doubles render cost and
  complexity. No evidence Story-native cuts outperform Reel reposts
  enough to justify a new rendering branch. Revisit after we have data
  on Story view-through.
- **Option C (skip Stories, do Threads/X instead):** strictly better
  for *traffic* (Threads posts carry clickable links), but the user
  asked for Stories specifically. Threads is on the backlog as its own
  plan.

## Architecture

```
render_short/route.ts
  ↓ (after Reel publish, sequential)
  publishShortToFacebookStory(...)   → publish-to-facebook-story.ts
  publishShortToInstagramStory(...)  → publish-to-instagram-story.ts
                                       ↓ on failure
                                       instagram_stories / facebook_stories row
                                       with status='failed'
                                       ↓
                                       /api/retry_instagram_stories  (cron */5)
                                       /api/retry_facebook_stories   (cron */5)
```

Each Story publisher mirrors its Reel sibling:

| Aspect | publish-to-instagram-story.ts | publish-to-facebook-story.ts |
|---|---|---|
| Endpoint | `POST graph.facebook.com/v22.0/{ig-id}/media?media_type=STORIES&video_url=…` → poll `?fields=status_code` → `media_publish?creation_id=…` | `POST graph.facebook.com/v22.0/{page-id}/video_stories?upload_phase=start` → rupload with file_url → poll `?fields=status` → `upload_phase=finish` |
| Auth | `FB_PAGE_ACCESS_TOKEN` (same as IG Reels) | `FB_PAGE_ACCESS_TOKEN` (same as FB Reels) |
| Settings | `publisher.instagram.auto_publish_story` (default off) | `publisher.facebook.auto_publish_story` (default off) |
| DB table | `instagram_stories` | `facebook_stories` |
| Resume key | `container_id` | `upload_session_id` |
| Caption | No (API does not accept) | No (API does not accept) |
| Retry cron | `/api/retry_instagram_stories` `4-59/5 * * * *` | `/api/retry_facebook_stories` `3-59/5 * * * *` |

## Verified endpoint shapes (against live Meta docs, 2026-06-25)

**IG Stories** (single subdomain):

```
POST graph.facebook.com/v22.0/{ig-id}/media
   body: access_token, media_type=STORIES, video_url
   → { id: <container_id> }

GET  graph.facebook.com/v22.0/{container_id}?fields=status_code&access_token=…
   → { status_code: "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED" }

POST graph.facebook.com/v22.0/{ig-id}/media_publish
   body: access_token, creation_id=<container_id>
   → { id: <post_id> }
```

**FB Page video stories** (two subdomains, 4-step):

```
POST graph.facebook.com/v22.0/{page-id}/video_stories
   body: access_token, upload_phase=start
   → { video_id, upload_url }     # upload_url is on rupload.facebook.com

POST {upload_url}                  # on rupload.facebook.com
   headers: Authorization: OAuth <token>, file_url: <public GCS url>
   (no body)
   → rupload pulls the bytes from the URL

GET  graph.facebook.com/v22.0/{video_id}?fields=status&access_token=…
   → { status: { video_status: "processing" | "ready" | "error" | "expired" } }

POST graph.facebook.com/v22.0/{page-id}/video_stories
   body: access_token, upload_phase=finish, video_id=…
   → { success: true, post_id }
```

We store `upload_session_id` (= `video_id` from step 1) on the
`facebook_stories` row so the retry cron can resume at the status poll
or finish without re-uploading. Plays the same role
`container_id` plays for IG.

## DB schema (rule 13 territory)

Two new tables in `schema.ts`: `INSTAGRAM_STORIES` and `FACEBOOK_STORIES`.
Mirror the Reel tables but **drop the `caption` column** (Stories don't
take captions) and the IG variant keeps `container_id` for resume; the
FB variant uses `upload_session_id`.

Append both tables to the `ALL_TABLES` array. `ensureSchema` reads that
array and runs `CREATE TABLE IF NOT EXISTS` on every cold start — no
migration files needed (this repo has no `migrations/` folder; schema
is enforced declaratively).

## Security (rule 13)

- `FB_PAGE_ACCESS_TOKEN` continues to live ONLY in server env vars,
  never in DB rows, never in logs. The existing `tokenFingerprint()`
  pattern (presence + length, no value) is duplicated verbatim in both
  new adapters.
- No new credentials. No new scopes. No App Review. Story publishing
  uses the same permission set the existing Reel publishers already
  hold.
- Retry cron routes are gated by `Bearer ${CRON_SECRET}` (mirrors
  `retry_instagram_publishes`).
- Defense-in-depth: each Story publisher refuses to publish if the
  row's stored `ig_account_id` / `page_id` doesn't match the current
  env var (catches env rotation mid-pipeline).
- Failure surfaces are bounded: a Story publish error logs + lands
  in its table; it MUST NOT bubble up and prevent the Reel publish
  result from being reported to the render route. `.catch()` wrapping
  in the render route mirrors the existing Reel call sites.

## Observability (rule 14)

Every step logs with a namespaced tag. Mirrors the Reel publisher
pattern verbatim:

- `[publish instagram_story attempt | container_created | container_poll | container_timeout | ok | error]`
- `[publish facebook_story attempt | started | uploaded | status_poll | status_timeout | ok | error]`
- `[retry_instagram_stories scan | done]` and `[retry_facebook_stories scan | done]`

When triaging a "Story didn't appear" report: grep render route logs
for `[publish instagram_story` or `[publish facebook_story` with the
story_id, walk back to the failure stage in one read.

## Settings audit (rule 15)

Two new toggles in `admin/(panel)/settings/socials/page.tsx`:

| Setting key | Group | Default | Label |
|---|---|---|---|
| `publisher.instagram.auto_publish_story` | Instagram section | OFF | "Also publish as a Story" |
| `publisher.facebook.auto_publish_story` | Facebook section | OFF | "Also publish as a Story" |

Hint text spells out the tradeoff plainly: "Stories appear at the top of
the feed for 24 hours but have no clickable link to the article.
Independent from the Reel toggle — you can have one on and the other
off."

Defaults OFF so this ships as opt-in. Intentionally not exposed yet:
Story duration cap (hard-coded per Meta's specs; the rendered short is
already ≤60s so the cap is never hit), Story-specific caption template
(Stories don't take captions; revisit if Meta exposes link stickers via
API).

## Testing (rule 18)

New vitest files mirror the Reel publisher coverage:

- `publish-to-instagram-story.test.ts` (13 tests):
  happy path · multi-poll · ERROR · timeout (skipped — known-flaky like
  the IG Reel sibling) · dedup · manual bypass · env missing · 4xx ·
  ig_account_id mismatch · resume from container_id · retry no-container ·
  retry not-eligible · delete success + failure

- `publish-to-facebook-story.test.ts` (14 tests):
  4-step happy path · multi-poll · start 4xx · rupload error · status
  error · dedup · manual bypass · env missing · page_id mismatch ·
  resume from upload_session_id · retry no-session · retry not-eligible ·
  delete success + failure

Run `pnpm test` after every step. Run `pnpm typecheck` before declaring
done. The repo has pre-existing typecheck errors in unrelated files
(useDebouncedSave.test.tsx, r2.ts/aws4fetch, article-payload.test.ts,
pipeline-cache-cleavage.test.ts) — those are not on the Stories diff
and not in scope.

## Deploy (rule 19)

- **Source branch:** `feat/youtube-and-tiktok-auto-publish` (this PR).
- **Branch state at write time:** behind main by many commits including
  the AGENTS.md production-incident rules. Per AGENTS.md, **do NOT
  merge to main yet** — main is also behind production
  (`feat/multi-platform-shorts-publisher` is the production-source
  branch in the inverted state). This PR lands as a preview only.
- **Pre-push divergence check:** before any push to this branch, run
  `git fetch origin && git log HEAD..origin/main --oneline` and
  `git log HEAD..origin/feat/multi-platform-shorts-publisher --oneline`.
  Bring missing commits in BEFORE pushing if either lists anything
  touching schema, publish-to-*, vercel.json, env keys, or render
  route paths.
- **Vercel UI safety:** never click "Promote to Production", "Redeploy",
  or "Rebuild" on any deployment from this branch (per AGENTS.md
  rule about the inverted state).
- **Rollback:** flipping both new toggles OFF in the admin UI is the
  zero-deploy rollback. No code change needed. If the toggles
  themselves fail to read (e.g. settings table corruption), the
  default is OFF — Story publishing is silently dormant.

## Known risks

- **Meta content-reuse rule** ("a video uploaded for a story can not
  have been used in a previously published post"). The same GCS URL
  is the source for the Reel publish minutes earlier. Real-world
  tooling crossposts the same URL without issue, but if Meta starts
  enforcing this strictly we'll see a specific FB error code on
  `upload_phase=start`. Mitigation if it hits: append `?v=story` to
  the GCS URL so the content hash differs.
- **Meta CDN rejection**: rupload rejects `fbcdn` URLs. We use GCS, so
  this doesn't affect us today.
- **robots.txt rejection**: rupload rejects files hosted on sites
  that restrict crawling via robots.txt. GCS public bucket object
  URLs do not serve a robots.txt, so we're fine.

## Implementation order

1. Schema: add `INSTAGRAM_STORIES` and `FACEBOOK_STORIES` to
   `schema.ts`, append to `ALL_TABLES`.
2. `publish-to-instagram-story.ts` + tests.
3. `publish-to-facebook-story.ts` + tests.
4. Wire both into `render_short/route.ts` after the existing Reel
   calls, with the `.catch()` swallow pattern.
5. Add toggles to the Socials admin page.
6. Add `/api/retry_instagram_stories/route.ts` and
   `/api/retry_facebook_stories/route.ts`. Append both crons and
   `maxDuration: 300` entries to `vercel.json`.
7. Full test + typecheck pass.

## References

- IG Content Publishing (Stories included): https://developers.facebook.com/docs/instagram-platform/content-publishing/
- Stories publishing announcement (2023): https://developers.facebook.com/blog/post/2023/05/16/introducing-stories-publishing-to-the-content-publishing-api-on-instagram/
- Page Stories API: https://developers.facebook.com/docs/page-stories-api/
- Content Publishing Limit: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit/
- AGENTS.md (deploy hygiene + Vercel inverted state): `./AGENTS.md`
