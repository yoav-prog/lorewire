# Engagement Polls + Divisive Rails (V2 → V3 groundwork)

Date: 2026-06-17
Status: Draft, awaiting approval
Owner: Yoav
Branch target: a new `feat/engagement-polls` branched off `feat/multi-platform-shorts-publisher`
Approved scope: Option C (on-site poll + burnt-in question card + recommendation engine groundwork).

## 1. Goals

End every short with an emotional question, host an interactive poll on the lorewire.com landing page that pays it off, and shape the resulting vote data so the V3 "Most Divisive / Community Agreed / Unpopular Opinions" rails and personalized feed are a query change, not a migration.

Three deliverables, one PR-sequence:

1. **Burnt-in question card** at the tail of every short MP4. Renders inside the existing Cloud Run pipeline so the same card travels intact through TikTok / Reels / YouTube Shorts / Facebook Reels.
2. **Interactive on-site poll** at the bottom of `/v/[slug]` and the linked-story article reader. Cookie-keyed anonymous voting; live percentage payoff; "see another divisive story" follow-up.
3. **Divisive / Agreed / Unpopular rails** on the homepage and as standalone category pages, computed from poll vote aggregates. Vote rows are shaped so V3 personalization (`always picks the woman's side`, `gravitates to twist endings`) is a JOIN, not a backfill.

The whole point per the user's strategy text: passive consumption on someone else's platform → active participation on yours. Without 1, social viewers never get the hook. Without 2, the hook has nothing to pay off. Without 3, we collect vote data we never use.

## 2. Constraints and decisions (locked at intake)

- **Polls live on stories**, not articles. One poll per story. Articles that link a story (`articles.story_id`) inherit and render the linked story's poll. Standalone-article polls are out of scope for v1 — flagged for later if the article CMS proves it needs them independently.
- **Anonymous voting** via an HttpOnly cookie carrying a 256-bit random token. No account required, no auth gate. One vote per browser per poll. We display percentages as marketing, never as scientific stats — the surface is built to never overstate methodology.
- **Burnt-in card is rendered, not spliced.** The existing intro/outro path picks pre-rendered MP4 segments from `video_segments`; that cannot carry per-story dynamic text. The question card is a new beat inside the Cloud Run renderer (Remotion composition), drawn from props at render time.
- **Caption-hook injection is parallel, not alternative.** The publisher's per-platform caption transformer ([_plans/2026-06-16-multi-platform-shorts-publisher.md §3.F2](2026-06-16-multi-platform-shorts-publisher.md)) gains a `{poll_hook}` template slot. Belt and suspenders: the muted scroller sees the burnt-in card, the caption reader sees the text, both routes lead to lorewire.com.
- **Build it, don't rent it.** No third-party poll service (Typeform, Poll Everywhere, etc). Lorewire owns the vote data because the data IS the recommendation signal.
- **No PII on votes.** The cookie token is a random nonce, not a fingerprint. We never store IP or User-Agent in the votes table. (We do hash IP+UA for the rate-limit bucket, but only inside a short-lived rate-limiter cache, not in durable storage.)
- **Vote count display is delayed-truthful.** Until a poll has at least 20 votes total we hide the percentages and show "Be one of the first to vote." Prevents the early-vote skew from advertising 100%/0% on minutes-old polls.

## 3. Requirements

### Functional

- F1. Admin opens `/admin/stories/[id]` and sees a "Poll" section. Fields: question (≤ 80 chars), option A label (≤ 24 chars), option B label (≤ 24 chars), enabled toggle. Defaults populated by a category-preset map (`Drama → "Who's wrong?"`, `Entitled → "Was she justified?"`, etc).
- F2. An "Auto-draft from story" button calls the existing LLM helper ([lorewire-app/src/lib/llm.ts](lorewire-app/src/lib/llm.ts)) with the story body and the category preset prompt; returns a JSON `{question, optionA, optionB}` validated at the boundary. Cost: ~$0.001 per click on the existing default model.
- F3. The short renderer reads the resolved poll from the story row and draws a 2.5s end card with the question + two option chips + a small "lorewire.com/v/<slug>" footer. Card style locked to the existing caption design tokens so it feels native, not bolted-on.
- F4. The publisher's caption transformer gets a `{poll_hook}` slot. Default template per platform:
  - YouTube: `\n\n👉 {question} Vote at lorewire.com/v/{slug}`
  - TikTok: `\n\n{question} 👉 lorewire.com/v/{slug}`
  - IG/FB: same as TikTok, hashtag-aware.
- F5. `/v/[slug]` renders the poll below the video, above the body. Two buttons (A / B), large, mobile-thumb-friendly. Click → server action → cookie set → results revealed inline.
- F6. The article reader (`/articles/[locale]/[slug]`) renders the same poll when the article has a non-null `story_id` and the linked story has an enabled poll.
- F7. Post-vote payoff: under the percentages, a "See another story like this" link that pulls from the same category's Divisive rail (so the user lands on another close-split story, not just a random next pick).
- F8. Three new public surfaces: `/c/divisive`, `/c/agreed`, `/c/unpopular`. Each is a server-rendered list of stories computed from `poll_votes` aggregates, paginated 20 per page.
- F9. Homepage gains three new optional rails: `most_divisive_row`, `community_agreed_row`, `unpopular_opinions_row`. Curation-system treats them as the existing rails — admin toggles which appear and in what order via `/admin/curation` (per [_plans/2026-06-16-homepage-curation.md](2026-06-16-homepage-curation.md)).
- F10. Admin "Polls" overview at `/admin/polls`. Table of every story with a poll: question, vote count, split percentage, % divisiveness rank, last-vote timestamp, sparkline of votes/day. Sortable. Click-through to the story page.
- F11. **Caption template settings cross the publisher plan.** New setting keys: `publisher.caption.{platform}.template` already exists in that plan's §12; we add `{poll_hook}` to the documented slot list and ship a default template per platform.

### Non-functional

- N1. **Vote write latency under 200ms p95.** Single INSERT, no joins, no FK checks.
- N2. **Aggregate read latency under 50ms p95** for the Divisive rail (already-indexed query against materialized `poll_aggregates`).
- N3. **Burnt-in card adds ≤ 2.5s to short duration.** This is the cost of the hook; non-negotiable but measured.
- N4. **No PII ever leaves the votes table.** Aggregates only on every public surface.
- N5. **Re-render on poll change is opt-in.** Changing the question on an already-rendered short surfaces a "Re-render with new question?" banner; doesn't auto-fire (re-renders cost money).
- N6. **Public surfaces never reveal individual votes** — only aggregates with a floor (20-vote minimum to show percentages).

## 4. Alternatives considered (re-stated for the record)

- **Option A** — On-site poll only. Rejected: feeds nothing into the social-platform pipeline; the funnel never closes from TikTok back to lorewire.com.
- **Option B-lite** — Poll + caption hook, no burnt-in card. Rejected because the user picked C. Note for the future: B-lite is the right fallback if the renderer change slips, because we can ship the on-site poll + caption hook without touching Cloud Run.
- **Option B-full** — Poll + caption hook + burnt-in card, no rails. Rejected because the user picked C. Same caveat: the rails work is shippable in isolation if the publisher pipeline isn't ready yet.
- **Option C** (chosen) — Polls + burnt-in card + rails + V3-shaped vote data.
- **Option D** — Rent a SaaS (Typeform, Polldaddy). Rejected on principle per the "build it, don't rent it" memory. Also: the entire point is to OWN the vote data because the data is the V3 personalization signal.

## 5. Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Admin: /admin/stories/[id]                                              │
│   PollEditor (question, optionA, optionB, enabled, auto-draft button)   │
│         │                                                                │
│         │ saveStoryPollAction                                            │
│         ▼                                                                │
│   polls table (one row per story)                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
┌──────────────┐    ┌──────────────────────┐    ┌─────────────────────────┐
│ Short        │    │ Public reader         │    │ Publisher caption       │
│ renderer     │    │ /v/[slug],            │    │ transformer (publisher  │
│ (Cloud Run): │    │ /articles/.../[slug]  │    │ plan §3.F2):            │
│ + QuestionCard│   │   PollWidget          │    │ injects {poll_hook}     │
│   beat at    │    │     vote action       │    │ slot from polls.        │
│   tail       │    │     results reveal    │    │ question + slug         │
└──────┬───────┘    └──────────┬────────────┘    └─────────────────────────┘
       │                       │
       │                       ▼
       │            ┌──────────────────────┐
       │            │ poll_votes (append-  │
       │            │ only, anonymous,     │
       │            │ cookie-keyed)        │
       │            └──────────┬───────────┘
       │                       │
       │                       ▼
       │            ┌──────────────────────────────┐
       │            │ poll_aggregates (materialized │
       │            │ snapshot, refreshed by Vercel │
       │            │ Cron every 5 min)             │
       │            └──────────┬────────────────────┘
       ▼                       │
┌──────────────┐               ▼
│ Burnt-in MP4 │    ┌──────────────────────────────┐
│ that travels │    │ Rails: /c/divisive, /c/agreed,│
│ to TikTok /  │    │ /c/unpopular + homepage rows  │
│ Reels / YT   │    │ via getHomepageCuration()     │
└──────────────┘    └──────────────────────────────┘
```

## 6. Data model

All raw-SQL, matching the existing `src/lib/schema.ts` shape. SQLite + Postgres parity.

```sql
-- One row per story that has a poll. NULL row = no poll on this story.
-- Question + option labels are short by contract (UI cap 80 / 24 / 24);
-- enforced at server-action boundary, not at the DB.
CREATE TABLE IF NOT EXISTS polls (
  id            TEXT PRIMARY KEY,           -- UUID
  story_id      TEXT NOT NULL,              -- FK logical only (cross-engine portability)
  question      TEXT NOT NULL,
  option_a_text TEXT NOT NULL,
  option_b_text TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1, -- 0/1; 0 hides the poll everywhere
  category      TEXT,                       -- denormalized from stories.category for fast rail queries
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_polls_story_id ON polls(story_id);
CREATE INDEX IF NOT EXISTS idx_polls_category_enabled ON polls(category, enabled);

-- Append-only vote log. One row per (poll, cookie_token).
-- cookie_token is a 256-bit random nonce set HttpOnly+Secure+SameSite=Lax.
-- ip_ua_hash is a SHA-256 of (ip || '\n' || user_agent) used ONLY for the
-- rate-limit bucket; never indexed, never read for personalization, gets
-- pruned by retention. Voter side encoded as 'A' | 'B'.
CREATE TABLE IF NOT EXISTS poll_votes (
  id            TEXT PRIMARY KEY,           -- UUID
  poll_id       TEXT NOT NULL,
  story_id      TEXT NOT NULL,              -- denormalized for rail queries without join
  category      TEXT,                       -- denormalized for category-filtered rails
  side          TEXT NOT NULL,              -- 'A' | 'B'
  cookie_token  TEXT NOT NULL,              -- 256-bit hex; primary anti-double-vote key
  ip_ua_hash    TEXT,                       -- SHA-256 hex; rate-limit only, pruned after 24h
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_votes_poll_cookie
  ON poll_votes(poll_id, cookie_token);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll_id ON poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_story_id ON poll_votes(story_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_created_at ON poll_votes(created_at);

-- Materialized aggregate refreshed every 5 minutes by Vercel Cron.
-- Reading this instead of COUNT(*)/GROUP BY on poll_votes is what keeps the
-- N2 50ms read latency budget. Floor logic ("show '<20 votes'") happens at
-- read time, not at write time, so the floor can be tuned without backfill.
CREATE TABLE IF NOT EXISTS poll_aggregates (
  story_id              TEXT PRIMARY KEY,
  poll_id               TEXT NOT NULL,
  category              TEXT,
  votes_a               INTEGER NOT NULL DEFAULT 0,
  votes_b               INTEGER NOT NULL DEFAULT 0,
  total_votes           INTEGER NOT NULL DEFAULT 0,
  divisiveness          REAL    NOT NULL DEFAULT 0,   -- 1 - |0.5 - pctA|*2; 1 = 50/50, 0 = 100/0
  agreement             REAL    NOT NULL DEFAULT 0,   -- 1 - divisiveness; convenience
  last_vote_at          TEXT,
  refreshed_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_poll_aggregates_divisiveness
  ON poll_aggregates(divisiveness DESC, total_votes DESC);
CREATE INDEX IF NOT EXISTS idx_poll_aggregates_agreement
  ON poll_aggregates(agreement DESC, total_votes DESC);
CREATE INDEX IF NOT EXISTS idx_poll_aggregates_category
  ON poll_aggregates(category, divisiveness DESC);
```

**Why three tables, not one**: `polls` is admin-authored config; `poll_votes` is hot append-only data; `poll_aggregates` is the read-optimized projection. Mixing them either bloats hot-path reads or fragments writes.

**Why denormalize `story_id` and `category` onto `poll_votes`**: rail queries filter by both without ever touching `stories`. Saves a join on what'll be the largest table in the schema. The denormalized fields are write-once (poll never moves stories).

**V3 personalization shape**: `poll_votes` carries `cookie_token`, `side`, `category`, `story_id`, `created_at`. That's enough to compute "this browser always picks A in Drama" without any schema change. Future work adds a `vote_features` table joined on `cookie_token` if we need richer signals (gender-of-side, story-tag features). The current shape doesn't paint us into a corner.

## 7. Files touched

### Schema + migrations

- [lorewire-app/src/lib/schema.ts](lorewire-app/src/lib/schema.ts) — add `POLLS`, `POLL_VOTES`, `POLL_AGGREGATES`. Add to `TABLES`. Add the four indexes to `POST_TABLE_DDL`.
- [pipeline/store.py](pipeline/store.py) — mirror CREATE TABLE + indexes; helpers `upsert_poll`, `insert_poll_vote`, `refresh_poll_aggregates(story_id | None)`. SQLite + Postgres parity, same patterns as `short_render_events`.

### Lorewire app (TS)

- **New:** [lorewire-app/src/lib/polls.ts](lorewire-app/src/lib/polls.ts) — typed accessors: `getPoll(storyId)`, `getPollAggregate(storyId)`, `recordVote(storyId, side, cookieToken)`, `topDivisive(opts)`, `topAgreed(opts)`, `topUnpopular(opts)`. Pure server. Plus `CATEGORY_POLL_PRESETS` (the question + option defaults per category).
- **New:** [lorewire-app/src/lib/poll-cookie.ts](lorewire-app/src/lib/poll-cookie.ts) — `getOrIssueVoteToken()`, the cookie name (`lw_vote`), shape mirrors `session.ts`. Random 256-bit token, HttpOnly, Secure (in prod), SameSite=Lax, 365-day expiry.
- **New:** [lorewire-app/src/app/admin/(panel)/stories/[id]/PollEditor.tsx](lorewire-app/src/app/admin/(panel)/stories/[id]/PollEditor.tsx) — server component with embedded form actions for save + auto-draft. Matches the existing `StoryAspectControl.tsx` pattern. Sits inside the existing `page.tsx` between StatusStepIndicator and the asset grid.
- **New:** [lorewire-app/src/app/admin/(panel)/polls/page.tsx](lorewire-app/src/app/admin/(panel)/polls/page.tsx) — overview table per F10.
- **New:** [lorewire-app/src/app/(public)/_components/PollWidget.tsx](lorewire-app/src/app/(public)/_components/PollWidget.tsx) — server component renders the question + buttons; a small client island handles the click → server action → reveal. Shared by `/v/[slug]` and `/articles/[locale]/[slug]`.
- **New:** [lorewire-app/src/app/api/polls/vote/route.ts](lorewire-app/src/app/api/polls/vote/route.ts) — POST endpoint backing the client island. Reads `lw_vote` cookie, validates `storyId` + `side`, inserts vote (idempotent on `(poll_id, cookie_token)`), returns refreshed aggregate. The reason this is an API route, not just a server action: the client island runs after hydration and we want a single fetch round-trip without a full page revalidation. Rate-limited per `ip_ua_hash` (10 votes/minute, separate from the per-cookie idempotency).
- **New:** [lorewire-app/src/app/api/polls/refresh/route.ts](lorewire-app/src/app/api/polls/refresh/route.ts) — Vercel Cron endpoint that refreshes `poll_aggregates`. 5-minute cadence. Per-story incremental refresh (only stories with new votes since last refresh).
- **New:** [lorewire-app/src/app/c/[surface]/page.tsx](lorewire-app/src/app/c/[surface]/page.tsx) — surface ∈ `divisive` | `agreed` | `unpopular`. Server-rendered story list.
- **Edit:** [lorewire-app/src/app/v/[slug]/page.tsx](lorewire-app/src/app/v/[slug]/page.tsx) — render `<PollWidget storyId={story.id} />` between the video and the body. Also render the "See another story like this" link below the poll when there's an aggregate to follow up with.
- **Edit:** [lorewire-app/src/app/articles/[locale]/[slug]/page.tsx](lorewire-app/src/app/articles/[locale]/[slug]/page.tsx) — render the same widget when `article.story_id` is set and the linked story has an enabled poll.
- **Edit:** [lorewire-app/src/app/actions.ts](lorewire-app/src/app/actions.ts) — `getHomepageCuration()` extended to fetch the three new derived rails when the curation rows include them.
- **Edit:** [lorewire-app/src/app/admin/(panel)/curation/page.tsx](lorewire-app/src/app/admin/(panel)/curation/page.tsx) — surface picker gains the three new surfaces. Each is a "derived" rail (admin can include/exclude + reorder, but doesn't pick individual stories; they're computed).
- **Edit:** [lorewire-app/src/lib/short-config.ts](lorewire-app/src/lib/short-config.ts) — add `question_card?: { question, option_a, option_b, slug, duration_ms }` to `ShortConfig`. Optional, populated by the short-build path from the poll record at render time.

### Short renderer (Cloud Run, Remotion)

- **Edit:** `video/src/DoodleShort.tsx` (Remotion composition) — new `QuestionCard` component (last beat). Props mirror `ShortConfig.question_card`. Hide-if-absent so old configs render unchanged.
- **Edit:** `pipeline/short_build.py` (or wherever short props get materialized) — read the story's poll and inject `question_card` into the props. Re-render trigger: any change to `polls.question | option_a_text | option_b_text` for an enabled poll surfaces a "Re-render with new question?" banner on `/admin/(panel)/shorts/[id]` (similar to the existing intro/outro change banner). No auto-fire.

### Publisher transformer

- **Edit:** the publisher plan's `mapShortToPlatformPayload` (file path lands when that plan implements; currently planned in [_plans/2026-06-16-multi-platform-shorts-publisher.md](2026-06-16-multi-platform-shorts-publisher.md) §3.F2) — `{poll_hook}` slot. Default templates per F4. The setting keys `publisher.caption.{platform}.template` get the new slot documented.
- **Edit:** publisher plan §12 settings + §13 tests — add the `{poll_hook}` slot to the template-substitution helper's test cases.

### Admin UI

- **Edit:** [lorewire-app/src/app/admin/(panel)/layout.tsx](lorewire-app/src/app/admin/(panel)/layout.tsx) — nav entry for "Polls" under the existing top-level (alongside "Curation").

### Settings

- **Edit:** [lorewire-app/src/app/admin/(panel)/settings/page.tsx](lorewire-app/src/app/admin/(panel)/settings/page.tsx) — new "Engagement → Polls" section per §10 below.

## 8. Public surfaces (UX)

### `/v/[slug]` poll widget

```
┌──────────────────────────────────────────────────────────────┐
│ [video player]                                               │
├──────────────────────────────────────────────────────────────┤
│ Who's wrong?                                                 │
│                                                              │
│  ┌───────────────────────┐  ┌───────────────────────┐       │
│  │     Wife              │  │     Husband           │       │
│  └───────────────────────┘  └───────────────────────┘       │
│                                                              │
│ [post-vote state — same widget after click:]                 │
│                                                              │
│ Who's wrong?                                                 │
│  ┌───────────────────────┐  ┌───────────────────────┐       │
│  │  Wife          72% ✓  │  │  Husband         28%  │       │
│  └───────────────────────┘  └───────────────────────┘       │
│                                                              │
│ 1,438 votes · You picked Wife                                │
│                                                              │
│ See another close call → "Roommate keeps stealing my food"   │
└──────────────────────────────────────────────────────────────┘
```

The pre-vote state shows just the question + 2 buttons. The post-vote state reveals percentages, total count, your pick, and a one-line follow-up link pulled from the same-category Divisive rail (F7). The follow-up link is the V3 personalization signal in disguise: it captures click-through from "I voted X" → "next story I clicked," and that pair is the seed of the future "your-side recommendations" model.

### `/c/divisive`, `/c/agreed`, `/c/unpopular`

Standard story-list pages. Each card shows the title, hero image, category chip, and a small split bar (e.g. `48% / 52%`). For Divisive, sorted by `divisiveness DESC, total_votes DESC`. For Agreed, by `agreement DESC, total_votes DESC`. For Unpopular, by a metric computed per-user (if cookie_token has votes) as "fraction of your votes on the losing side."

Unpopular for a brand-new visitor (no cookie history) falls back to "stories where the smaller side is < 15%" so the page never reads empty.

### Homepage rails

Three new optional rails inserted via `/admin/curation`. The admin toggles them on/off and reorders them; the surface contents are derived, not curated by hand.

### Burnt-in question card (rendered)

Static 2.5s frame at the tail of the short. Black background, the question centered (caption-style typography to feel native), two option chips (matching the on-site widget's chip style), and a small "Vote at lorewire.com/v/<slug>" footer at the bottom. Card uses the existing caption design tokens so it doesn't feel like a separate piece of art.

Slug overlay is the only piece that needs per-story templating; the rest of the card style is shared across all shorts.

## 9. Security (rule 13)

- **Sensitive data**: the cookie token is anonymous but it is the anti-double-vote primitive. If it's predictable, an attacker can fabricate votes. We use `crypto.randomBytes(32)` (Node) for 256-bit entropy.
- **Cookie flags**: HttpOnly, Secure (in prod), SameSite=Lax, Path=/, 365-day Max-Age. SameSite=Lax (not Strict) so the vote action works when the user lands from a TikTok / Reels click (cross-site GET → POST on first interaction).
- **Rate limit on /api/polls/vote**: 10 votes/minute per `ip_ua_hash` bucket, 60 votes/hour per `ip_ua_hash`. Bucket lives in-memory per Vercel region with a Postgres fallback for cross-region (using a `rate_limits` table that the publisher plan also benefits from; build once, share). Exceeded → 429 with `Retry-After`. Per rule 14, log `[polls vote rate-limit]` with `{storyId, hashPrefix, bucketState}` (hashPrefix = first 8 hex chars, never the full hash).
- **CSRF**: vote endpoint is POST-only with `Content-Type: application/json`, body `{storyId, side}`, and the cookie token is HttpOnly so client JS can't read it to leak. Origin check on the request (`Origin` header must match the configured site origin). The browser sets the cookie on first vote attempt if absent; subsequent votes prove ownership by carrying the cookie.
- **Input validation**: server-side Zod-shape check on `{storyId: uuid, side: 'A'|'B'}`. Anything else → 400. Per rule 1, validate at the boundary, never trust the client.
- **No PII anywhere**: votes table has no IP, no User-Agent, no fingerprint. The `ip_ua_hash` field is a one-way SHA-256 used only for rate-limit lookup; pruned by retention after 24h (the same Cron that refreshes aggregates also nulls `ip_ua_hash` on rows older than 24h).
- **LLM-suggest hardening**: the "auto-draft from story" prompt runs admin-only (`requireAdmin()`), and the LLM output is parsed into `{question, optionA, optionB}` with length caps before display. The output is never rendered as HTML, only as text content.
- **Public read paths never leak individual votes**: every public surface reads from `poll_aggregates`, not `poll_votes`. No public API exposes `cookie_token` or `ip_ua_hash`. An admin-only `/admin/polls/[storyId]/votes` page can show raw rows for debugging, gated by `requireAdmin()`.
- **GDPR**: anonymous votes carry no personal data. Even the cookie token, in isolation, is not personal data because it's not linkable to a person. We document this in the privacy policy alongside the publisher plan's privacy section.
- **Vote abuse policy**: we display percentages as marketing, never as scientific or representative stats. Public-facing copy says "Lorewire community votes" with no methodology claim. The 20-vote floor (N6) protects against early skew embarrassment.

## 10. Observability (rule 14)

Every step emits a namespaced log line. Grep targets:

- `[polls editor save]` — admin saves poll. `{storyId, question, optionA, optionB, enabled}`.
- `[polls editor draft]` — auto-draft from LLM. `{storyId, category, prompt_tokens, output_tokens, cost_cents}`.
- `[polls vote]` — vote recorded. `{storyId, side, cookieTokenPrefix, isFirstVoteForCookie}`.
- `[polls vote rate-limit]` — 429 fired. `{storyId, ipUaHashPrefix, bucketCount}`.
- `[polls vote duplicate]` — same cookie re-voted. `{storyId, side, originalSide}`. We accept-and-noop rather than 409 so the UX feels normal across stale tabs.
- `[polls aggregate refresh]` — cron tick. `{storiesRefreshed, totalVotesIngested, durationMs}`.
- `[polls rail query]` — read for a rail surface. `{rail, limit, durationMs, resultCount}`.
- `[short build question-card]` — renderer reads poll for end-card props. `{storyId, hasPoll, questionLen}`.
- `[publisher caption hook]` — caption transformer injects `{poll_hook}`. `{storyId, platform, finalCaptionLen}`. (Lives in the publisher plan's namespace but tagged with `hook=poll` so the two plans' logs join.)

Levels: `info` for normal lifecycle, `warn` for rate-limit and duplicate-vote, `error` only for terminal failures (DB write fails, etc).

**Per-story dashboard surface**: `/admin/polls/[storyId]` shows the sparkline (votes/day) and the current split. Per-day vote series read from `poll_votes` grouped by `date(created_at)` — slow query but admin-only, fine.

**Daily summary alert**: a Vercel Cron at 09:00 emails Yoav the previous 24h: new polls, polls with > 100 votes, polls with 0 votes after 24h since publish, any cookie-token that voted on > 50 different stories (probable scraper or rate-limit miss).

## 11. Settings audit (rule 15)

New "Engagement → Polls" section on `/admin/(panel)/settings/page.tsx`:

| Key | Type | Default | Hint copy |
|---|---|---|---|
| `polls.enabled` | bool | true | "Master switch for the polls feature across the site, video shorts, and publisher captions." |
| `polls.public_floor` | int | 20 | "Hide percentages until a poll has at least this many votes. Prevents early-vote skew." |
| `polls.show_total_count` | bool | true | "Show 'X votes' next to the percentages once a poll passes the floor." |
| `polls.cookie_ttl_days` | int | 365 | "How long the anonymous vote cookie lives. Affects per-browser anti-double-vote and the V3 personalization signal." |
| `polls.preset.{category}.question` | string | (per-category default) | "Default question for stories in this category. Overridden per-story by the admin." |
| `polls.preset.{category}.option_a` | string | (per-category default) | "Default option A label for this category." |
| `polls.preset.{category}.option_b` | string | (per-category default) | "Default option B label for this category." |
| `polls.endcard.enabled` | bool | true | "Render the burnt-in question card at the tail of every short. Turn off if you want caption-only hooks." |
| `polls.endcard.duration_ms` | int | 2500 | "How long the question card holds at the tail. 2500ms is the validated default." |
| `polls.rail.divisive_enabled` | bool | true | "Show the Most Divisive rail on the homepage when curated in." |
| `polls.rail.agreed_enabled` | bool | true | "Show the Community Agreed rail when curated in." |
| `polls.rail.unpopular_enabled` | bool | true | "Show the Unpopular Opinions rail when curated in." |
| `polls.rate_limit.per_minute` | int | 10 | "Votes/minute per IP+UA bucket. Lower if abuse appears." |
| `polls.rate_limit.per_hour` | int | 60 | "Votes/hour per IP+UA bucket." |

**Intentionally NOT exposed**: the cookie name (`lw_vote` — codified), the cookie token entropy (256-bit — operational config), the aggregate refresh cadence (5min — codified Cron), the question-card visual style (lives in renderer code so it tracks the caption design tokens).

**Settings groupings**: one collapsed section titled "Engagement → Polls" with two sub-sections: "Behavior" (the booleans and ints) and "Per-category defaults" (the 6 × 3 preset matrix). Mirrors the publisher plan's "Engagement → Publisher" pattern.

## 12. Cost (rule 8)

Verified at execution time, per rule 1. As of plan date 2026-06-17:

| Item | Cost | Note |
|---|---|---|
| LLM "auto-draft from story" | ~$0.001/click | One call to the existing `llm.ts` default model (~500 input tokens + ~50 output). Pennies per story. Re-verify the per-1k token cost on the active model at implementation time. |
| Burnt-in question card | ~$0.01–0.03/render | Adds 2.5s × ~2 fps of Remotion rendering on Cloud Run. Current cost analysis from [_plans/2026-06-14-cloud-run-render.md](2026-06-14-cloud-run-render.md) applies — re-verify on implementation. |
| Vote ingest (Postgres on Neon) | $0 | Within free tier even at 100k votes/day (~3M/month, ~1 GB storage for the votes table). |
| Aggregate refresh Cron | $0 | One Vercel Cron tick every 5 minutes; well inside the Vercel cron budget. |
| Polling endpoint hits (Vercel functions) | ~$0–5/month | Vote POST + aggregate GET = 2 calls per voter. At 10k votes/day = 20k function invocations = inside Pro tier. |
| Storage (votes + aggregates) | ~$0.10/GB/month | Negligible at 1 GB for 100M votes (~1 year at 100k/day). |

**Total marginal cost**: <$10/month at planned volume. Re-verify against current Neon and Vercel pricing at implementation time.

## 13. Testing (rule 18)

### Unit (Vitest)

- `lib/polls.test.ts` — Zod-style validation of poll inputs; length caps enforced; category-preset defaults resolve correctly.
- `lib/poll-cookie.test.ts` — cookie token is 256 bits, HttpOnly/Secure/SameSite=Lax flags set; re-read returns same token.
- `lib/short-config.test.ts` (extend) — `question_card` field parses + survives round-trip; absent on configs that don't have a poll.
- `lib/divisiveness.test.ts` — the divisiveness/agreement math: 50/50 → divisiveness=1, 100/0 → divisiveness=0, 75/25 → divisiveness=0.5.

### Schema regression (write-the-failing-test-first per rule 18)

- A test that inserts two `poll_votes` rows with the same `(poll_id, cookie_token)` and expects the second to fail by `idx_poll_votes_poll_cookie`. Mirrors the publisher plan's F7 contradiction test pattern.
- A test that inserts a vote, refreshes aggregates, reads back, asserts the math.

### Integration

- **Vote action**: POST `/api/polls/vote` with valid body + cookie → 200, vote inserted, aggregate refreshed in-place if the cron just ran.
- **Vote idempotency**: same cookie re-votes → 200, no duplicate row, `[polls vote duplicate]` logged.
- **Vote rate-limit**: 11 votes/minute from same `ip_ua_hash` → 11th returns 429 with `Retry-After`.
- **Cookie absent**: first POST issues cookie and accepts vote; second POST with the issued cookie is accepted (not duplicate).
- **Origin mismatch**: POST with wrong `Origin` header → 403.
- **Floor**: aggregate read with < 20 total returns `null` percentages so the widget renders the pre-floor copy.
- **Auto-draft LLM**: mocked LLM returns valid JSON → saved; returns garbage → server action surfaces a clear error, nothing written.

### Renderer (Python)

- `pipeline/tests/test_short_build_question_card.py` — short_build emits `question_card` in props when the story has an enabled poll; omits it when no poll or `polls.endcard.enabled` is false.
- Remotion-side: a smoke test that renders one short with `question_card` set and asserts the output MP4 is exactly 2.5s longer than the same short without the field.

### Publisher cross-plan

- The publisher plan's `mapShortToPlatformPayload.test.ts` gains a case: when a story has an enabled poll, the per-platform caption contains the `{poll_hook}` substitution.

### Manual QA

- Publish a story with a poll. Verify:
  - `/v/[slug]` shows the poll. Vote works. Percentages reveal. Cookie persists across reloads.
  - Article linking the story renders the same poll.
  - Short MP4 has the question card at the tail.
  - The publisher caption (when the publisher ships) contains the `{poll_hook}` line.
- Vote 15 times rapidly from one browser → 429 after 10.
- Vote on 20 stories from one browser → counted as 20 votes, one per story.
- Open the homepage; verify the three new rails appear when toggled on.
- `/c/divisive` shows the closest-split stories first; `/c/agreed` shows the most lopsided; `/c/unpopular` shows the "your votes vs majority" mismatches (or the floor surface when no cookie history).

## 14. Phased delivery

Total: ~9 working days. Each phase shippable independently — no big-bang merge.

### Phase 1 — Data + admin editor (2 days)

- Schema migrations (TS + Python).
- `polls.ts` accessors + tests.
- `PollEditor` on `/admin/stories/[id]` + auto-draft button.
- `/admin/polls` overview page.
- `[polls editor save]` + `[polls editor draft]` observability live.
- Definition of done: admin can create, edit, and view polls on stories.

### Phase 2 — On-site widget + voting (2 days)

- `PollWidget` component + `poll-cookie.ts`.
- `/api/polls/vote` route + rate limit.
- `/api/polls/refresh` Cron.
- `/v/[slug]` + article reader integration.
- `[polls vote]` + `[polls aggregate refresh]` observability live.
- Definition of done: end users can vote, see results, cookie persists, cron refreshes aggregates.

### Phase 3 — Burnt-in card (2 days)

- `ShortConfig.question_card` field + parser.
- `pipeline/short_build` injects from poll.
- Remotion `QuestionCard` component.
- "Re-render with new question?" banner on the short editor when the poll text changes after the last successful render.
- `[short build question-card]` observability live.
- Definition of done: every short rendered after this phase carries the end card; old shorts get a "re-render to add card" banner.

### Phase 4 — Divisive / Agreed / Unpopular rails (2 days)

- `/c/divisive`, `/c/agreed`, `/c/unpopular` pages.
- Three new homepage surfaces in `getHomepageCuration()`.
- Admin curation UI gains the three derived surfaces.
- Post-vote follow-up link on `/v/[slug]` pulls from same-category Divisive rail.
- `[polls rail query]` observability live.
- Definition of done: all three surfaces render; homepage rails appear when toggled in.

### Phase 5 — Publisher caption hook + polish (1 day, blocked on publisher Phase 1)

- `{poll_hook}` slot added to the publisher's per-platform caption transformer.
- Defaults per platform (F4).
- Tests in the publisher plan extended.
- Daily summary alert email.
- Definition of done: a one-click publish via the publisher route includes the poll hook in the caption.

## 15. Open questions (none blocking)

1. **Standalone-article polls** (poll authored directly in the Tiptap editor, not inherited from a story). Out of scope for v1; the model supports it cleanly via a `polls.article_id` add later. Decide after we see whether standalone articles draw enough engagement to want their own polls.
2. **Per-platform question variants** — the burnt-in card is the same question across all platforms today. If a future test shows that "Who's wrong?" outperforms "Who do you support?" on TikTok but not Reels, we add a per-platform override on the poll record. Not now.
3. **Vote weighting**. Today every vote counts 1. Future: weight votes from cookies that have a longer history (more anti-bot signal). Pure V3 work; data shape already supports it.
4. **Recommendation engine model**. The "see another close call" link today is a SQL query. V3 will replace it with a per-cookie scoring model. The vote shape (cookie_token, side, story_id, category, created_at) is already what a model would consume.

## 16. Risks

- **Polls without traffic die quiet**. If a story has < 20 votes after 24h, the floor hides the percentages, and the surface looks broken to subsequent visitors. Mitigated by the daily summary email surfacing zero-vote polls so we can prune or boost them. If this is a recurring pattern, we lower the floor to 10 or add a "first vote reveals" mode.
- **Burnt-in card eats 2.5s of every short**. Real cost in attention. Mitigated by A/B-able settings (`polls.endcard.enabled`, `polls.endcard.duration_ms`) so we can shrink or kill it per category based on retention metrics.
- **Cookie vote is trivially defeated** by incognito or new browser. The percentage is marketing, not science — never displayed as methodology. The 20-vote floor + the rate limit are what prevent visible manipulation; the cookie is the no-friction "don't double-count the same person" defense.
- **Re-render cost on question change**. Changing the question after the short renders means burning Cloud Run credits to re-render. Mitigated by the banner-not-auto-fire policy: the admin sees the banner and chooses.
- **Aggregate refresh staleness**. 5-minute cron means the displayed percentage lags up to 5 minutes behind reality. Fine for a marketing percentage; not fine if we ever surface it as a competition (e.g., "vote now, results in 1h"). For v1, the lag is invisible.
- **The recommendation rails are degenerate without volume**. Until ~50 stories have ≥ 20 votes each, all three rails look thin. Mitigated by the floor and by hiding rails with < 6 entries (so a half-empty rail doesn't ship).
- **Publisher plan cross-dependency**. The `{poll_hook}` slot lives in a plan that may slip. Phase 5 is gated on publisher Phase 1. Until it ships, the on-site poll + burnt-in card both work — we just don't get the social-platform caption hook. Acceptable degradation.
- **LLM auto-draft quality**. If the model returns awkward questions for a category, admins ignore the button. Mitigated by category presets so the manual default is already decent; the LLM is a convenience, not a backbone.

## 17. Definition of done (overall)

- Admin can author a poll on any story and see a live overview at `/admin/polls`.
- Public `/v/[slug]` renders the poll widget, accepts votes, persists cookies, reveals percentages above the floor, and links to a follow-up story.
- Article reader renders the same widget for stories its linked to.
- Every short rendered post-Phase-3 carries a 2.5s question card at the tail.
- `/c/divisive`, `/c/agreed`, `/c/unpopular` render correctly; homepage rails appear when toggled.
- Publisher captions include the `{poll_hook}` substitution once the publisher route lands.
- All tests in §13 green.
- All observability namespaces from §10 produce diagnosable logs.
- Settings section per §11 renders and persists.
- Cost stays under $10/month at planned volume.

## 18. Revision log

- **2026-06-17 (initial draft)**: First plan written after Yoav chose Option C. Built directly off the visible state of `feat/multi-platform-shorts-publisher` (re-synced after the session-start pull). Cross-referenced to the publisher plan ([_plans/2026-06-16-multi-platform-shorts-publisher.md](2026-06-16-multi-platform-shorts-publisher.md)) and the homepage curation plan ([_plans/2026-06-16-homepage-curation.md](2026-06-16-homepage-curation.md)).
