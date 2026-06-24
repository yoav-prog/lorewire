# Bulk-publish video stories to socials from /admin/content

Date: 2026-06-24
Branch: `feat/youtube-and-tiktok-auto-publish` (deploying onto `feat/multi-platform-shorts-publisher`)
Status: APPROVED — implementation in progress

## Goal

From the unified content inbox at `/admin/content`, let an operator:

1. Multi-select one or more video stories and bulk-publish them to one
   or more social platforms (Facebook, Instagram, YouTube, TikTok) in
   one click.
2. See per-row icons indicating which platforms each story is already
   published to, at a glance.
3. Filter the list by "published on" platform(s) — see "every story
   live on YouTube but not yet on TikTok", etc.

## Why

The existing per-short editor publish buttons are great for one-at-a-
time work but the operator routinely wants to push a week's backlog
to all four platforms in one pass after running the SEO regeneration.
Today that's 20+ clicks across as many tabs. After this PR it's one
click in the content list.

## Scope

In scope:
- Extend `ContentRow.published_on: { facebook, instagram, youtube, tiktok }`
- Aggregate query helper `loadPublishedOnByStoryIds(storyIds[])` —
  one query per platform table, returns a Map for batch use.
- Extend `listContentSlim` with a `publishedOn` filter param
  (multi-platform, "include any of" semantics).
- New `bulkPublishToSocialsAction(items, platforms[])` server action.
- Per-row platform icons in `ContentList.tsx`.
- New "Publish to socials ▾" multi-platform picker in `BulkActionBar`.
- New "Published on" filter chip row in `content/page.tsx`.

Out of scope:
- Per-platform UNPUBLISH (deleting a previously-posted FB/IG/YT video
  bulk — the per-story editor handles this; bulk-delete is dangerous
  and a different design conversation).
- Republishing with delete-previous semantics (manual editor still has
  this; bulk publish creates a new row on top of any existing one,
  same dedup behavior as the existing manual button).
- Bulk SEO regeneration before publishing (the user can regenerate
  per-story; bulk regen is a Phase 2 if needed).

## Architecture

### Data shape

```ts
interface PublishedOn {
  facebook: boolean;   // any row with status='posted' for this story
  instagram: boolean;
  youtube: boolean;
  tiktok: boolean;
}

interface ContentRow {
  // ...existing fields...
  published_on: PublishedOn;  // articles always all-false
}
```

### Aggregate query

`loadPublishedOnByStoryIds(storyIds: string[])` runs four small queries
in parallel:

```sql
SELECT DISTINCT story_id FROM facebook_posts
  WHERE story_id IN (?, ?, ..., ?) AND status = 'posted';
-- same shape for instagram_posts, youtube_posts, tiktok_posts
```

Then builds a `Map<string, PublishedOn>` with all-false defaults and
flips the matching booleans on. Single map for callers to consume.

### Filter semantics

`publishedOn: ("facebook"|"instagram"|"youtube"|"tiktok")[]`

A row passes if EVERY listed platform is published. So
`publishedOn=['facebook','youtube']` shows "stories live on both
FB AND YT". The "any of" alternative is less useful — an operator
usually asks "what's NOT yet on TikTok" which is achievable by
selecting just TikTok plus a NOT toggle (Phase 2 if needed).

For now, AND semantics + a `publishedNotOn` param for the inverse
("not yet on TikTok" → `publishedNotOn=tiktok`).

### Bulk publish action

`bulkPublishToSocialsAction(items: BulkContentItem[], platforms: Platform[])`:

For each story × platform combination:
1. Skip if not a story (articles can't publish to social).
2. Skip if no completed short render exists (no video_url).
3. Look up the article URL for the metadata context (existing
   `resolveArticleUrlForStory` helper).
4. Call the matching `publishShortTo<Platform>` with `trigger='manual'`.
   (Trigger='manual' bypasses the auto-publish toggle so the operator
   gets what they clicked.)
5. Collect the result: `posted`, `pending` (TikTok), `failed`, `skipped`.

Returns:
```ts
{
  posted: { kind, id, platform, externalId? }[];
  pending: { kind, id, platform }[];   // TikTok inbox mode lands here
  failed: { kind, id, platform, reason }[];
  skipped: { kind, id, platform, reason }[]; // no render / not a story
}
```

The publishers themselves are platform-agnostic at the action level —
the loop just maps platform name → publisher function.

## UI

### Per-row icons

Inline next to the status pill. Tight 4-icon strip showing only the
platforms the story has been published to (absent icons = not
published). Hover tooltip says "Posted to YouTube on 2026-06-24".

Icons: lettered SVG badges with brand colors. F (blue) / I (gradient
pink/orange) / Y (red) / T (black). Lettered keeps it dependency-free
and recognisable; full logos require licensing care and add bundle
weight for marginal admin-only value.

### Bulk picker

Add to the existing sticky `BulkActionBar`:

```
[Publish to socials ▾]   ← new
  ├── ☐ Facebook
  ├── ☐ Instagram
  ├── ☐ YouTube
  ├── ☐ TikTok
  └── [Publish to N selected]
```

Multi-select inside the dropdown. Confirm button at the bottom of the
menu shows the count + platforms picked. Click outside to cancel.

### Filter chip row

Same shape as the existing Kind / Status / Language chip rows. Sits
between Status and Language:

```
Published on  [All] [Facebook] [Instagram] [YouTube] [TikTok]
              [Not on TikTok] [Not on YouTube] ...
```

Multi-select via URL query param `?publishedOn=facebook,youtube`. The
NOT-toggle gets its own row to keep the AND/NOT semantics legible.

## Security (rule 13)

- Bulk action goes through `requireAdmin` / `requireCapability("content.manage")`,
  matching the per-row actions.
- Publishers' env-only credential pattern unchanged. Bulk action never
  touches the credentials directly — it just calls the existing
  publishers in a loop.
- Defense in depth: each publisher still validates open_id / channel_id
  / page_id against env vars on each call. Bulk doesn't bypass that.

## Observability (rule 14)

Logs namespaced `[content list bulk-publish]`:
- `start` — count, platforms, user_id
- `per_item` — story_id, platform, status (posted / pending / failed / skipped), reason
- `done` — total_posted, total_pending, total_failed, total_skipped, latency_ms

Each publisher's own `[publish * attempt]` events fire as usual, so
the bulk action's logs are an index over the per-publisher trace.

## Settings (rule 15)

No new settings. The action respects each platform's existing
auto-publish setting indirectly (manual trigger bypasses the toggle
on purpose — the operator's click is the trigger).

## Testing (rule 18)

Unit:
- `loadPublishedOnByStoryIds`: empty input → empty map. Single story
  posted to FB only → flag set, others false. Story posted to all four
  → all true.
- `bulkPublishToSocialsAction` shape: empty platforms array → no-op.
  Articles in input → marked skipped, never reach publishers. Story
  without a done render → marked skipped before the publisher fires.
- Filter SQL: `publishedOn=facebook,youtube` returns only rows in BOTH.

Integration (with stubbed publishers):
- 3 stories × 4 platforms = 12 calls in the right order; result map
  aggregates correctly.
- One platform's publisher throws → that one item lands in `failed`,
  others continue.

Manual smoke:
- Select 3 stories, pick FB+IG+YT, click publish. Watch logs for
  `[content list bulk-publish start]` → 12 per-item events → `done`.
- Verify the row icons update on next page refresh.

## Cost (rule 8)

- Same cost as 12 manual publishes (no extra LLM or render calls).
- Each platform's existing rate limits apply unchanged. Bulk-of-3 is
  far below TikTok's 6 req/min, IG's 100/24h, FB's effective ceiling.
- No new infra. Reuses the existing publisher modules + retry crons.

## Phased rollout

1. Land this PR.
2. After deploy, smoke-test: select 1 story, publish to FB only via
   the bulk picker. Confirm the FB icon appears next to the row on
   refresh. Confirm the existing per-row publish-status banners on
   the short editor still work.
3. Try a 3-story × 4-platform batch.
4. If the bulk action is too slow for large batches (>10 stories ×
   4 platforms = 40 calls), Phase 2.1 fans out per-platform in
   parallel (today the bulk action loops sequentially).

## Open items

None. Ready to implement.
