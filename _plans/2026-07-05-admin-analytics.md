# Admin analytics dashboard

Date: 2026-07-05
Branch: `feat/admin-analytics` (cut from origin/main @ 6801d6c)
Status: approved by standing request ("add a robust, extremely informative, beautiful, UI/UX friendly, intuitive, clean analytics of the site, with many breakdowns of specific stories, charts, search, everything").

## Goal

Give the studio a first-class Analytics section in the admin: what is the
audience doing, which stories work, how polls split, how publishing is
going — with real charts, per-story drilldowns, and search. Everything is
computed from data the site already records; no new tracking is added.

## What data exists (verified in code)

- `story_events` — the core signal. One row per anonymous engagement event
  (`play_started`, `play_completed`, `save_added`, `rating_submitted`,
  `poll_vote`, `share_initiated`) with `anon_id`, ISO `occurred_at`, and a
  weight baked at write time (lib/story-events.ts). Consent-gated: only
  visitors who accepted the CCM19 banner produce rows.
- `poll_votes` (append-only log) + `poll_aggregates` (5-min cron
  projection with divisiveness/agreement).
- `user_saves`, `user_likes` (signed-in), `users` (members via
  `provider IS NOT NULL`).
- `comments` (per article; articles link to stories via
  `articles.story_id`).
- `facebook_posts` / `instagram_posts` / `youtube_posts` / `tiktok_posts`
  — uniform `story_id`, `status`, `posted_at`, `created_at` columns.
- `stories` (`category`, `status`, `published_at`, `duration`,
  `cost_cents`), `story_tags`, `categories`.

Not available (and therefore intentionally NOT shown): page views /
impressions (GA4 only, external), watch-time seconds (only the 90%
completion threshold exists), CTR.

## Approach chosen

One new sidebar destination, two pages, one data module, hand-rolled SVG
charts.

- `/admin/analytics` — overview. Range picker (7 / 30 / 90 days / all,
  default 30) via `?range=` searchParam so the URL is shareable and the
  page stays a server component. Sections: KPI cards with deltas vs the
  previous period, daily engagement trend chart, category breakdown,
  event mix, searchable + sortable story performance table, poll
  highlights (most voted / most divisive / most agreed), publishing by
  platform, audience (daily unique viewers, new members).
- `/admin/analytics/[storyId]` — per-story drilldown: KPIs, daily trend,
  play→completion funnel, poll split, saves/likes/comments, social posts
  for that story. Linked from every row of the overview table and
  cross-linked to the story editor.
- `src/lib/analytics.ts` — "server-only" query module on the `all()` seam
  in lib/db.ts. Portable SQL only (works on SQLite and Postgres): day
  bucketing via `substr(occurred_at, 1, 10)`, range filtering via a
  computed ISO cutoff parameter. No new tables, no new cron.
- Charts: small bespoke SVG components under
  `(panel)/analytics/_components/` — a multi-series trend chart (client,
  hover tooltip), horizontal category bars, split bars, donut. Pure
  geometry/formatting lives in `chart-math.ts` so it is unit-testable.

## Alternatives rejected

- **Recharts (or tremor/visx)** — good charts fast, but the repo has zero
  UI dependencies by design (pure Tailwind, hand-built tables/controls)
  and the "build it, don't rent it" rule applies. A dependency also drags
  ~100KB+ into the admin bundle for four chart shapes we can draw in
  ~300 lines of SVG.
- **GA4 Data API integration** — would add page views, but requires a
  service account, quota management, and an external dependency for a
  dashboard that should work on day one from first-party data. Can be a
  later phase if page views become a must.
- **Pre-aggregated analytics tables + cron** — not needed at current
  volume; `story_events` queries with the existing index shape are cheap.
  Revisit if event volume makes the overview slow (the module logs query
  durations so we will see it coming).

## Security

- Both pages gate on `requireCapability("content.manage")`; the sidebar
  item is hidden for roles without it (server gate stays authoritative).
- Read-only feature: no mutations, no server actions, no new API routes.
- No PII surfaced: anon ids are only ever COUNT(DISTINCT ...)-ed, never
  listed; member counts are aggregates.
- All SQL is parameterized through the existing `all()` helper; the
  range value is parsed against a closed enum before it reaches SQL.

## Observability

- Every query function logs `[analytics query] { fn, rangeDays, ms,
  rows }` via console.info (rule 14).
- The interactive table logs `[analytics table]` on search/sort actions
  at debug-friendly volume (first interaction per kind).

## Settings audit

- Range default (30d) is a URL param, not a hidden setting — shareable
  and obvious. No new settings exposed on purpose: the dashboard has no
  behavior to configure yet. If a "default range" preference is ever
  wanted it belongs in the admin settings hub.

## Testing

- `src/lib/analytics.test.ts` — vitest against the real SQLite seam
  (same pattern as polls.test.ts): seeded `test-analytics-*` rows,
  covering range cutoffs (in/out of window), day bucketing, overview
  totals + deltas, top-story ordering, completion-rate division-by-zero,
  per-story drilldown shape, and empty-DB behavior.
- `chart-math.test.ts` — pure: tick generation, path building on empty /
  single-point / flat series, compact number formatting (0, 999, 1000,
  1.5M), percent formatting.
- Full `npm test` run must be green apart from the 4 pre-existing
  failures already on main (documented in memory).

## Deploy

- Feature branch → PR into `main`; merge deploys via Vercel as usual.
  No env vars, no schema migration (read-only), no cron changes.
  Rollback = revert the PR.
