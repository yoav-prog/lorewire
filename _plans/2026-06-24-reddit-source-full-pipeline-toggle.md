# 2026-06-24 — Reddit source "Full Pipeline" toggle (auto-publish on completion)

Date: 2026-06-24
Branch: `feat/facebook-auto-publish` (current) — see Branch Hygiene at the bottom
Status: **DRAFT — awaiting Yoav's sign-off before any code**

## Goal

Add a per-source **Full Pipeline** toggle on `/admin/reddit-sources`. When a row's toggle is ON and the admin processes that row, the pipeline runs every stage end-to-end (article body + scenes/gallery + read-along audio + hero + thumbnail + short with default intro/outro + poll/vote question) and, **on full success of every stage**, automatically publishes the story to the public site (and to the wired social channels — currently Facebook).

If any stage fails or produces a fallback artifact, the story does **NOT** auto-publish. It stays in review with a clear, namespaced failure log so the admin can intervene.

This is the per-source control + auto-publish layer on top of the existing pipeline-completeness work.

## Recent feature awareness — audit since the prior plan (Rule 1: verify what shipped)

Between 2026-06-16 and 2026-06-23 the repo added/shipped several features that change what "fully published" means. The plan below incorporates every one of these; called out here so a reviewer can audit them as a flat list.

| Area | Plan / commit | What Full Pipeline must do |
|---|---|---|
| **Multi-platform shorts publisher** | [_plans/2026-06-16-multi-platform-shorts-publisher.md](_plans/2026-06-16-multi-platform-shorts-publisher.md) — only Facebook leg shipped (commit `139d85a`); YT/IG/TikTok deferred | Today: Facebook only. Plan exposes auto-publish destinations as a Settings list (`reddit.full_pipeline.auto_publish.*`) so YT/IG/TikTok flip on without code churn when shipped. |
| **Audio-rights / clearance gate** | shipped with multi-platform publisher | Full Pipeline must check `audio_clearance_status` (or equivalent) before publishing anywhere. Blocked clearance = `full_pipeline_blocked` event; no auto-publish. Added as an explicit check-ready gate. |
| **R2 media migration + URL rewriter** | [_plans/2026-06-22-r2-media-migration-and-avatar-upload.md](_plans/2026-06-22-r2-media-migration-and-avatar-upload.md), [_plans/2026-06-23-pipeline-outbound-url-rewriter.md](_plans/2026-06-23-pipeline-outbound-url-rewriter.md) — shipped (commit `3855d5f`) + recent `6668f4d` "stop rewriting intro/outro segment URLs on the Cloud Run dispatch" | Every outbound URL (Facebook fetch, OG share image, short_render props passed to Cloud Run, embedded image src in article body) MUST go through `resolveMediaUrl()` (TS) / `resolve_media_url()` (Python). Auto-publish that hands Facebook a raw GCS URL will silently 404. Added as a publish-time URL sweep. |
| **Hook-first shorts restructure** | [_plans/2026-06-21-shorts-hook-first-restructure.md](_plans/2026-06-21-shorts-hook-first-restructure.md) — draft, not shipped per memory `project_shorts_hookfirst_state` | Hook-first will co-emit `{question, optionA, optionB}` from the script LLM. Full Pipeline must accept poll from EITHER path: (a) script payload if hook-first is live, (b) `poll-autodraft.ts` otherwise. The "poll is AI-generated, not preset fallback" check works for both. |
| **Article comments + AI moderation** | [_plans/2026-06-22-article-comments-ai-moderation.md](_plans/2026-06-22-article-comments-ai-moderation.md) — eval harness shipped; per-story Comments open/closed toggle landed | Auto-publish must initialize the per-story Comments toggle. Default = whatever the global default is at publish time. New Settings key: `reddit.full_pipeline.comments_default` (`open`/`closed`). |
| **Ratings + share** | [_plans/2026-06-22-ratings-and-share.md](_plans/2026-06-22-ratings-and-share.md) — share shipped (`3add3ac`), ratings are client-only | Nothing to initialize server-side. Share button works on any published story. The share image (OG) must use the thumbnail's landscape variant — confirm at publish-time URL sweep. |
| **Wires (formerly Reels) + likes** | [_plans/2026-06-22-wires-rename-player-and-likes.md](_plans/2026-06-22-wires-rename-player-and-likes.md) — shipped | Terminology: refer to the vertical feed as "Wires" everywhere new (admin copy, tooltips). Likes init: auto-published stories start at 0; the existing "below threshold = hide count" UI handles this — Full Pipeline does NOT need to seed likes. |
| **Category classifier + pills** | [_plans/2026-06-21-category-classifier-and-pills.md](_plans/2026-06-21-category-classifier-and-pills.md) — shipped (`534d681`) | `category` must be non-null before auto-publish. NULL category silently defaults to "Drama" at display time, which would mis-route the story on category rails. Added to check-ready gate. |
| **Homepage curation** | [_plans/2026-06-16-homepage-curation.md](_plans/2026-06-16-homepage-curation.md) — shipped | A published story appears on the homepage only via the curation table OR the fallback path when curation is empty. Auto-publish does NOT add to curation by default — that's an editorial choice. New Settings key: `reddit.full_pipeline.add_to_curation` (default `0`) for future use. For now, Full Pipeline trusts the curation/fallback logic to surface published stories. |
| **GDPR compliance** | [_plans/2026-06-22-gdpr-compliance.md](_plans/2026-06-22-gdpr-compliance.md) — shipped | No publish-time gate. Published Lorewire stories are Lorewire-owned per the data model. Noted for completeness. |
| **Anonymous-first auth** | [_plans/2026-06-19-anonymous-first-auth.md](_plans/2026-06-19-anonymous-first-auth.md) — shipped | Published stories must be readable fully anonymous. No auth gate added. |
| **Voiceover presets** | [_plans/2026-06-22-admin-voiceover-presets.md](_plans/2026-06-22-admin-voiceover-presets.md) — draft, not shipped | Full Pipeline uses today's hardcoded short voice defaults (memory `feedback_short_voice_defaults`: Autonoe + calm + atempo 1.2 + 1s hook pause). When presets ship, the per-category preset overrides automatically — no Full Pipeline code change needed. |
| **Caption accuracy / read-along** | [_plans/2026-06-18-caption-accuracy-and-naturalness.md](_plans/2026-06-18-caption-accuracy-and-naturalness.md) — research only, not shipped | Read-along uses the existing audio-alignment path (narration + per-paragraph timestamps already produced by the pipeline). Full Pipeline check-ready requires `narration_alignment` to be present and non-empty before publish. |
| **Reddit-source bulk actions** | [_plans/2026-06-19-content-bulk-actions.md](_plans/2026-06-19-content-bulk-actions.md) — shipped (commit `791f92d`) | The "Mark Full Pipeline" + "Mark Review-only" bulk actions slot directly into the existing `bulkUpdateContentAction` pattern. No new bulk-action infrastructure needed. |
| **Story-job event timeline** | [_plans/2026-06-16-story-job-event-timeline.md](_plans/2026-06-16-story-job-event-timeline.md) — shipped | The `StoryJobEventTimeline` component I'm extending is the right one. New `full_pipeline_*` events render in the same stream. |
| **Brand-safety / hook-first state** | memory `project_shorts_hookfirst_state` — in flight | Full Pipeline blocks publish if the existing short-pipeline brand-safety gate trips. No new check needed; the failure already lands as a failed short_render which check-ready catches. |
| **Cost cap / 24h budget** | existing `getBudgetSummary` + `shorts.auto.daily_cap` | Reused unchanged. Full Pipeline also gets its own `max_concurrent` cap (see Settings). |

**Verification before code (Rule 1):** before any implementation, grep/read each of these to confirm the audit is correct on the live branch state. Specifically: confirm `audio_clearance_status` column exists and what its values are; confirm `resolveMediaUrl()` is the canonical helper; confirm the per-story Comments toggle column name; confirm `stories.category` is the column name post-classifier.

## Relationship to prior plans (Rule 1: verify)

- [_plans/2026-06-19-reddit-source-auto-deliver-article-short-hero-thumbnail.md](_plans/2026-06-19-reddit-source-auto-deliver-article-short-hero-thumbnail.md) already designs "every Reddit row produces article + short + hero + thumbnail." This new plan **assumes that work has shipped** and is the foundation. **Before any code, I verify the 4-artifact pipeline is actually wired** (grep `generate_hero_and_thumbnail_from_short`, `force=True` in `shorts_auto`, `thumbnail_image` column in stories). If any of it is partial, that gets flagged first — not silently worked around.
- [_plans/2026-06-17-engagement-polls.md](_plans/2026-06-17-engagement-polls.md) + [src/lib/poll-autodraft.ts](lorewire-app/src/lib/poll-autodraft.ts) already auto-draft a poll per story on create. **No new poll generator needed** — Full Pipeline mode only enforces that the poll ends up with `enabled=1` (LLM path, not fallback) before publish, otherwise hold for review.
- [_plans/2026-06-23-facebook-auto-publish.md](_plans/2026-06-23-facebook-auto-publish.md) shipped the FB publisher with auto/manual triggers + a `facebook_posts` queue + retry cron. **No new publisher needed** — Full Pipeline mode flips the gate so the publisher fires for these stories.

## What we are NOT doing

- Not changing how individual stages work (article, media, short, thumbnail, hero, poll). They already work.
- Not adding new social platforms (YouTube/IG/TikTok). When those exist, the Full Pipeline auto-publish set extends; not now.
- Not removing the existing manual "Publish" button on the story detail page. Manual review remains the default for non-toggled sources.
- Not building a global "Full Pipeline mode for everything" replacement. The toggle is per-source.

## Constraints and known risks

- **Production currently deploys from a non-main branch** ([AGENTS.md](lorewire-app/AGENTS.md) git workflow). Any push, merge, or Vercel UI action requires the divergence check + the "do not manually promote" rule. **This plan does not push or merge.** It produces code on the current branch and stops at "ready for Yoav's review."
- **Cost**: Full Pipeline = every paid stage. Per the 2026-06-19 cost table, ~$0.50–0.70 (short) + ~$0.20 (5x i2i for hero/thumbnail variants) + article LLM + audio TTS + scene images + poll LLM. Roughly **$1–1.50 per source** with current pricing. Real numbers re-checked at implementation per Rule 8.
- **Auto-publish is irreversible-ish.** Once a story is live on the site and posted to Facebook, taking it down requires DB flip + FB delete API call. Stakes are real — every gate matters.
- **Idempotency.** A Full Pipeline job can be retried (manual re-process, cron drain). The auto-publish step must dedup against any existing public publish.
- **Failure mode for partial pipelines:** If the short renders fine but the poll LLM falls back to preset, we do NOT auto-publish. Half-publishing a story with a generic preset poll degrades the brand.

## Requirements

### Functional

1. Each Reddit source row in [/admin/reddit-sources](lorewire-app/src/app/admin/(panel)/reddit-sources/) has a "Full Pipeline" toggle. State persists per row.
2. Toggle ON + admin processes the row → job enqueued with `full_pipeline=1`. Worker runs every stage, no skipping. On full success across every stage, story publishes automatically (site + Facebook). On any stage failure or fallback artifact, story stays in review.
3. Toggle OFF (default) → existing behavior: stages run per current pipeline, story lands in review for manual publish.
4. Bulk "Mark N as Full Pipeline" action in the existing footer, matching the bulk-action UX already there.
5. Per-row visual indicator in the table (badge or column) showing the toggle state at a glance — Rule 10 (lazy user) + Rule 16 (clear UI).
6. Detail page shows a "Full Pipeline" banner with a step-by-step log timeline (extends the existing `StoryJobEventTimeline`).
7. Global Settings:
   - Default for newly imported sources (off/on).
   - List of auto-publish destinations (web is always on; Facebook is on/off; others greyed-out until built).
   - Hard cap: max concurrent Full Pipeline jobs (cost guard).

### Non-functional

- Logs use `[full-pipeline <reddit-id> <stage>] { ...values }` namespace on both TS and Python sides. Stage transitions also write `story_job_events` rows so the admin timeline narrates the full flow (Rule 14).
- Server-only modules for anything touching credentials. No client bundles see FB tokens or LLM keys.
- Tests: Vitest for TS (per `stories.test.ts` pattern), pytest for Python worker (per `pipeline/tests/test_*` pattern). Rule 18: green run of the relevant suites before "done."

## Alternatives considered (Rule 4)

### Option A — Per-row toggle, opt-in, with bulk action (RECOMMENDED)

Each source row has its own toggle. Default off. Footer adds "Mark N as Full Pipeline" alongside the existing bulk actions. Settings adds a "Default Full Pipeline for new imports" knob + an auto-publish destination list + a cost cap.

**Pros:** matches the user's phrasing ("the sources I choose to generate"). Maximum control per source. Re-uses the existing bulk-action pattern. The toggle state is a queryable column — supports future analytics ("what % of imports get full-piped").

**Cons:** one extra column on `reddit_source`. One extra UI control per row.

### Option B — No per-row state, "Process N + Full Pipeline" as a separate footer button

No DB column. Footer gets a second button: "Process N (Full Pipeline)" next to "Process N (Review)." The choice is made at processing time, not on the source itself.

**Pros:** smaller diff. No new DB column. The semantic is "this is a workflow choice, not a property of the source."

**Cons:** loses the ability to mark sources in advance ("I want these 30 to go full when I get around to them"). Loses the visual indicator on the row. Doesn't support a "default on for new imports" setting cleanly. User's phrasing ("toggle on the source") favors A.

### Option C — Global Full Pipeline mode

One Settings switch. When ON, every processed source runs full pipeline. No per-row choice.

**Pros:** simplest code path. No new column. No new UI on the table.

**Cons:** loses cherry-pick control. Contradicts the user's phrasing. Hard to migrate to per-row later without UI churn. Rejected.

### Recommendation: **Option A.**

The user explicitly said "a toggle of full pipeline" "in reddit sources" and "the sources i choose to generate" — that's a per-source property, not a workflow flag. Option A also gives us the audit trail (we can ask "which sources are full-pipeline'd?") and aligns with the existing per-row toggles already in the table (status, strength). Option B's "smaller diff" win is marginal once Settings + auto-publish are added; the column is one cheap migration.

## Detailed design (Option A)

### 1. Schema

Migration: add to `reddit_source` table.

```sql
ALTER TABLE reddit_source
  ADD COLUMN full_pipeline INTEGER NOT NULL DEFAULT 0;
```

Propagate through the job queue. Add to `story_jobs`:

```sql
ALTER TABLE story_jobs
  ADD COLUMN full_pipeline INTEGER NOT NULL DEFAULT 0;
```

Update [src/lib/schema.ts](lorewire-app/src/lib/schema.ts) REDDIT_SOURCE + STORY_JOBS table definitions to register the new column. Update [src/lib/reddit-source.ts](lorewire-app/src/lib/reddit-source.ts) `RedditSourceRow` interface.

### 2. TypeScript surface

[src/lib/reddit-source.ts](lorewire-app/src/lib/reddit-source.ts):
- `setRedditSourceFullPipeline(redditId: string, value: boolean): Promise<void>`
- `bulkSetRedditSourceFullPipeline(redditIds: string[], value: boolean): Promise<{updated: number}>`
- Update `listRedditSources` / `getRedditSource` to surface `full_pipeline`.

[src/lib/story-jobs.ts](lorewire-app/src/lib/story-jobs.ts) `bulkEnqueueStoryJobs`:
- Accept and persist `full_pipeline` on each job row. Default false. When the calling action enqueues from a source with `full_pipeline=1`, the job carries the flag through to the worker.

[src/app/admin/actions.ts](lorewire-app/src/app/admin/actions.ts):
- New server actions: `setRedditSourceFullPipelineAction`, `bulkSetRedditSourceFullPipelineAction`.
- `processRedditSourcesAction` — when reading the source rows, propagate each row's `full_pipeline` into the corresponding job row at enqueue time.

### 3. Admin UI

[src/app/admin/(panel)/reddit-sources/RedditSourceTable.tsx](lorewire-app/src/app/admin/(panel)/reddit-sources/RedditSourceTable.tsx):
- New column "Full Pipeline" between status and actions. Compact switch with label "Full" / "Review" on hover. Visual: a small filled badge when on (matches the existing priority strength badge style — Rule 2: match the file's existing pattern).
- Toggle calls `setRedditSourceFullPipelineAction` optimistically; revalidates on error.
- Bulk footer: "Mark Full Pipeline (N)" + "Mark Review-only (N)" actions alongside the existing buttons.
- Tooltip on the column header explaining what Full Pipeline does (Rule 10: lazy user — no hidden behaviors).

[src/app/admin/(panel)/reddit-sources/[reddit_id]/page.tsx](lorewire-app/src/app/admin/(panel)/reddit-sources/[reddit_id]/page.tsx):
- Show a "Full Pipeline" pill at the top when the source has the flag on.
- Add a banner explaining "This source will auto-publish on full success" with the destinations listed (web, Facebook).

[src/app/admin/(panel)/reddit-sources/StoryJobEventTimeline.tsx](lorewire-app/src/app/admin/(panel)/reddit-sources/StoryJobEventTimeline.tsx):
- When the job is Full Pipeline mode, render the timeline with explicit step grouping: Article → Audio → Scenes/Gallery → Hero → Thumbnail → Short → Poll → Publish. Each group expandable; current step highlighted; failures shown in red with the structured payload visible.

[src/app/admin/(panel)/settings/page.tsx](lorewire-app/src/app/admin/(panel)/settings/page.tsx) — add a "Reddit Source Full Pipeline" section (Rule 15):
- `reddit.full_pipeline.default_on_import` (default `0`)
- `reddit.full_pipeline.auto_publish.web` (default `1`, the whole point)
- `reddit.full_pipeline.auto_publish.facebook` (default `1` when Facebook auto-publish is on globally, otherwise `0`)
- `reddit.full_pipeline.max_concurrent` (default `2`) — cost guard
- `reddit.full_pipeline.require_ai_poll` (default `1`) — when on, a fallback (preset) poll counts as a stage failure and blocks auto-publish

### 4. Python worker

[pipeline/story_jobs_worker.py](pipeline/story_jobs_worker.py) `_default_process`:
- Read `full_pipeline` from the claimed job row.
- Run the existing stages (already runs all 4 artifacts per the 2026-06-19 plan). The worker doesn't need new stages — it needs a finisher.
- After every stage completes successfully, run a Full Pipeline finisher:
  1. **Check-ready gate** (one consolidated check; every line must pass or auto-publish is blocked):
     - **Article artifacts**: `stories.body` non-empty, `stories.title` non-empty, `stories.summary` non-empty.
     - **Category finalized**: `stories.category` non-null (post-classifier). NULL would silently default to "Drama" at display time — that's a publish bug, not an auto-publish.
     - **Hero + thumbnail**: `hero_image`, `hero_image_landscape`, `thumbnail_image`, `thumbnail_image_landscape`, `thumbnail_image_square` all non-null (from 2026-06-19 plan).
     - **Audio + read-along**: narration audio URL non-null AND narration alignment (per-paragraph timestamps) non-empty.
     - **Scenes / gallery**: scenes list present with the expected count for the article body.
     - **Short**: latest `short_renders` row for the story has `status='done'`, with intro/outro segments stitched and brand-safety gate passed (existing checks; no new gate).
     - **Poll**: a `polls` row exists for this story_id with `enabled=1` (LLM-generated, not preset fallback). When `reddit.full_pipeline.require_ai_poll=0`, also accepts `enabled=0` fallback. When the hook-first short ships, the poll may have been co-generated by the script LLM — same check applies.
     - **Audio-rights / clearance**: `audio_clearance_status != 'blocked'` (or whichever column the multi-platform publisher landed; verify before code).
     - **URL hygiene**: every media URL in the story row, short_renders.props, and article body image refs resolves through `resolveMediaUrl()` to an R2 URL. Any raw GCS URL is rewritten in place (or auto-publish blocks if rewrite fails).
  2. **On any gate failure**: log a structured failure, write a `story_job_events` row `full_pipeline_blocked` with the exact list of failed gates (not just "missing artifacts" — say which ones), and mark the job done **without auto-publishing**. Story stays in review. Each failure has a clear admin-readable copy: "Full Pipeline blocked: thumbnail_image_square missing; re-process to retry."
  3. **On all gates passing**:
     - Flip `stories.status='published'`.
     - Initialize the per-story Comments toggle to the value of `reddit.full_pipeline.comments_default`.
     - Likes counter: do NOT seed (existing UI hides count below threshold; auto-published stories show no count until organic engagement crosses the threshold).
     - Write `story_job_events` row `full_pipeline_auto_publishing` with the destination list.
     - Trigger destinations:
       - Web publish: write a row to `pending_auto_publishes` (durable, retryable) that the new TS cron drains.
       - Facebook publish: invoke `publishShortToFacebook(...)` with `trigger='auto'`. The publisher already dedups on `story_id`; if a row exists, skip.
       - Future YT/IG/TikTok: same pattern — destinations list in Settings drives which adapters fire.
     - Do NOT auto-add to homepage curation (editorial choice). The existing curation/fallback logic surfaces the story.

### 5. Auto-publish bridge (TS ↔ Python)

The worker is Python; the publish path is TS. Two options:

- **Bridge A:** worker writes a row to a new `pending_auto_publishes` table; existing TS cron drains it and calls `publishStoryAction` + `publishShortToFacebook`.
- **Bridge B:** worker calls a new TS endpoint `/api/full_pipeline/publish` with the story_id + a shared secret env var.

Bridge A is more robust (durable, retryable, no fire-and-forget HTTP). Recommend A. Schema:

```sql
CREATE TABLE pending_auto_publishes (
  id text primary key,
  story_id text not null unique,
  reddit_id text not null,
  status text not null,             -- 'pending' | 'done' | 'failed'
  destinations text not null,       -- json: ["web","facebook"]
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
```

New cron: [src/app/api/drain_auto_publishes/route.ts](lorewire-app/src/app/api/drain_auto_publishes/route.ts) — Vercel cron entry, advisory-lock pattern from `render_short/route.ts`.

### 6. Failure semantics

- Any stage failure → no auto-publish, story stays in review, admin sees red row in timeline with the failure event.
- Poll fell back to preset → no auto-publish (if `require_ai_poll=1`).
- Timeline shows the "Full Pipeline blocked" event with the exact missing-artifact list so the admin knows what to fix.
- A re-process of the same source row re-runs the pipeline; if all stages succeed second time, auto-publish proceeds.

## Security (Rule 13)

- New columns store flags and IDs only — no PII, no credentials.
- The cron endpoint `/api/drain_auto_publishes` uses the same shared-secret auth pattern as `render_short/route.ts` and `retry_facebook_publishes/route.ts`. Don't add a new auth scheme.
- The Facebook publisher path already exists with its credential locked to server-only env vars. Full Pipeline reuses it; no new credential surface.
- Audit log: every auto-publish writes a `story_job_events` row (who/when/what) — durable record of what we shipped automatically.
- Cost guard: `reddit.full_pipeline.max_concurrent` setting bounds runaway spend. Also relies on the existing daily budget gate (`getBudgetSummary`).
- Brand-safety guard (carry over from the existing voice/hook conventions): if the short fails its existing brand-safety gates (already in `pipeline/shorts.py`), Full Pipeline does not auto-publish.
- **Never log full LLM outputs, Facebook tokens, or user PII** in the Full Pipeline log stream. The event payloads include IDs + small structured values only.

Pre-implementation: check current best practices for auto-publish gating + idempotency online per Rule 13 (training data ages).

## Observability (Rule 14)

Every Full Pipeline transition writes one `story_job_events` row AND one console line.

**TS side** (`namespacedLog` style):
```
[full-pipeline enqueue]      { reddit_id, story_id, source_full_pipeline: true, destinations: ["web","facebook"] }
[full-pipeline check-ready]  { reddit_id, story_id, missing: [], poll_ai: true }
[full-pipeline publish-web]  { reddit_id, story_id, status_before: "review", status_after: "published" }
[full-pipeline publish-fb]   { reddit_id, story_id, fb_post_id: "...", trigger: "auto" }
[full-pipeline blocked]      { reddit_id, story_id, missing: ["thumbnail_image","poll_ai"], reason: "..." }
[full-pipeline done]         { reddit_id, story_id, destinations_published: ["web","facebook"], elapsed_ms }
```

**Python side** (matching `[shorts_auto cap]` style):
```
[full-pipeline finisher] story={id} stage=check_ready missing=[] poll_ai=True
[full-pipeline finisher] story={id} stage=enqueue_publish destinations=['web','facebook']
[full-pipeline finisher] story={id} stage=blocked reason=poll_fallback
```

`story_job_events` event names: `full_pipeline_started`, `full_pipeline_check_ready`, `full_pipeline_blocked`, `full_pipeline_auto_publishing`, `full_pipeline_published_web`, `full_pipeline_published_facebook`, `full_pipeline_done`, `full_pipeline_failed`.

Admin timeline UI renders these inline with the existing event stream — same component, no new viewer.

## Settings audit (Rule 15)

New keys land in [src/app/admin/(panel)/settings/page.tsx](lorewire-app/src/app/admin/(panel)/settings/page.tsx) under a new **"Reddit Source Full Pipeline"** group. Defaults chosen for safe rollout (off by default, opt-in destinations):

| Key | Default | What it does |
|---|---|---|
| `reddit.full_pipeline.default_on_import` | `0` | When importing new Reddit candidates, set `full_pipeline=1` automatically. Off so existing import workflow doesn't change. |
| `reddit.full_pipeline.auto_publish.web` | `1` | If off, Full Pipeline still runs all stages but leaves the story in review. The whole point of the feature, but exposed so we can pause auto-publish without disabling the pipeline. |
| `reddit.full_pipeline.auto_publish.facebook` | `1` | Mirrors the global Facebook auto-publish setting. |
| `reddit.full_pipeline.max_concurrent` | `2` | Cost guard. Worker checks this before claiming Full Pipeline jobs. |
| `reddit.full_pipeline.require_ai_poll` | `1` | If on, a fallback (preset) poll blocks auto-publish. If off, fallback polls publish too (looser brand). |
| `reddit.full_pipeline.comments_default` | `open` | Per-story Comments toggle initialized to this on auto-publish. Matches the existing per-story toggle column added with the comments feature. |
| `reddit.full_pipeline.add_to_curation` | `0` | Future-use. When `1`, auto-publish would add the story to the homepage hero rail. Default off — curation stays editorial. Knob exists so we don't re-architect later. |
| `reddit.full_pipeline.url_sweep.fail_on_legacy_gcs` | `1` | If on, any media URL not resolvable through `resolveMediaUrl()` blocks auto-publish. If off, the sweep rewrites best-effort and continues. Default on (safest). |

**Intentionally NOT exposed:** the list of stages to run (always all). The poll question text (auto-drafted; admin can edit pre-publish if Full Pipeline didn't fire). The short voice defaults (locked per memory + brand spec). The audio-rights gate (cannot be bypassed — legal risk). The category finalization gate (would publish broken display state).

If the settings page surface is at capacity, the new group sits under the existing "Auto publish" section it already maps to — same logical home, one more sub-group.

## UX (Rules 10, 16)

- Toggle column is small but visually obvious. Sticker badge "FULL" when on; muted "REVIEW" placeholder when off (so the column doesn't look empty).
- Tooltip on hover, explained in plain words: "Process this source end-to-end and publish automatically when every stage succeeds."
- Confirm prompt on the bulk action: "Mark N sources as Full Pipeline? They'll auto-publish on success when you process them. Cost ~$1–1.50 per source."
- On the detail page, when toggle is on: a banner shows "Auto-publish armed: web, Facebook" so the admin never gets surprised by a story going live.
- Timeline groups stages with named headers + checkmarks/X marks. A lazy admin lands on the page mid-pipeline and instantly sees what's done, what's running, what's blocked.
- Empty / error states have human copy: "Full pipeline blocked: missing thumbnail (3:4). Re-process to retry."

No AI-generated visual tells (Rule 5): same control palette as the existing toggles in the table; same badge shape as the priority strength badge.

## Testing (Rule 18)

**TS (Vitest, collocated `*.test.ts`):**

- `reddit-source.test.ts` — `setRedditSourceFullPipeline` writes the column; `bulkSetRedditSourceFullPipeline` flips many rows; `listRedditSources` returns the new field.
- `story-jobs.test.ts` — `bulkEnqueueStoryJobs` propagates `full_pipeline` from source to job; default false; mixed batches preserve each row's flag.
- `actions.test.ts` (or co-located) — `processRedditSourcesAction` reads source `full_pipeline` and writes it to jobs.
- `RedditSourceTable.test.tsx` — toggle renders correct state, fires action on click, optimistic update + rollback on error, bulk action fires `bulkSetRedditSourceFullPipelineAction`.
- `drain_auto_publishes.test.ts` — cron drains pending rows, dedups against existing publishes, marks success/failure correctly.
- `publish-to-facebook.test.ts` (extend) — Full Pipeline auto-publish path is exercised end-to-end with mocked HTTP.

**Python (pytest):**

- `pipeline/tests/test_full_pipeline_finisher.py` — given a story with all artifacts present + `enabled=1` poll, finisher writes `pending_auto_publishes` row with both destinations. Missing artifact → no row + `full_pipeline_blocked` event. Fallback poll + `require_ai_poll=1` → blocked. Fallback poll + `require_ai_poll=0` → publishes.
- `pipeline/tests/test_story_job_worker_full_pipeline.py` — claimed job with `full_pipeline=1` runs all stages, finisher fires on success, story status flips, events are emitted in order.

**Migration & schema:**
- `schema.test.ts` — new column is registered; types compile.
- Migration applies cleanly to a fresh DB and a populated DB; existing rows default to `0`.

Bar: green run of `pnpm test` for the affected packages and `pytest pipeline/` before calling done. No "looks right to me."

## Cost (Rule 8)

Pricing checked live at implementation time per Rule 8 (not from training data). Approximate per-source cost when Full Pipeline runs:

| Stage | Approx cost |
|---|---|
| Article LLM (idea, research, body, title) | ~$0.05 |
| Audio TTS narration | ~$0.10 |
| Scene image generation (3–5 scenes) | ~$0.15 |
| Short render (Cloud Run + i2i in shorts pipeline) | ~$0.50–0.70 |
| Hero + thumbnail (5x i2i variants per 2026-06-19 plan) | ~$0.20 |
| Poll LLM (small json call) | ~$0.001 |
| Facebook publish call | $0 |
| **Total per source (Full Pipeline)** | **~$1.00–1.50** |

Settings cap (`reddit.full_pipeline.max_concurrent`) + existing daily budget gate are the backstops against "Process 500 selected" silent spend. Confirmation prompt also calls out the per-source cost so the admin doesn't slip.

**Action item before implementing:** check current kie pricing + LLM provider pricing per Rule 8.

## Branch hygiene (Rule from AGENTS.md)

- Current branch: `feat/facebook-auto-publish`. Builds directly on the Facebook publisher this feature reuses.
- **Before writing code:** `git fetch origin`, then run BOTH divergence checks from AGENTS.md against `main` AND against whatever branch Vercel Production is currently tracking. If this branch is behind, bring main / production-source in first.
- This plan does **not** push or merge anything. Implementation finishes at "ready for Yoav's review on the branch." Push + PR creation is a separate decision per the rules.
- Do NOT manually promote any preview build in Vercel UI — production-source branch only (per AGENTS.md).

## Rollback

All changes are additive:
- New columns default `0` — old code paths ignore them.
- `processRedditSourcesAction` reads the flag but the default-false path is the existing behavior.
- The cron endpoint is new — disabling it (env var off) immediately stops all auto-publishes; pending rows can be drained or deleted manually.
- Settings keys default to safe values — feature is "off" until the admin toggles a source on.

Revert path: `git revert` the migration commit + the worker commit. Existing rows with `full_pipeline=1` become inert; pending publish rows can be cleared by hand.

## Decisions — RESOLVED 2026-06-24

| # | Question | Decision |
|---|---|---|
| 1 | Auto-publish destinations day 1 | **Web + Facebook**. Both via the existing publishers; both Settings-toggleable for pull-back. |
| 2 | Default for newly imported sources | **Off by default, opt-in per source**, AND a bulk multi-select footer action so many sources can be flipped on at once. (Bulk action is already in the design.) |
| 3 | Fallback poll | **Block publish.** `require_ai_poll=1` is the default. |
| 4 | Short brand-safety gate failure | **Hard-block auto-publish.** Story stays in review with the brand-safety failure logged. |
| 5 | Re-process previously auto-published | **Re-render artifacts; do NOT re-publish.** Dedup via existing `facebook_posts` + `stories.status='published'` checks; no double FB post. |
| 6 | Comments default on auto-published | **Open.** Matches site default; AI moderation handles the queue. |
| 7 | Audio-rights gate | **Hard-coded, never bypassable.** No Settings escape hatch. Legal-risk gate. |
| 8 | R2 URL sweep failure mode | **Block publish on any unrewriteable URL.** `fail_on_legacy_gcs=1` default. |
| 9 | Hook-first poll coupling | **Autodraft handles idempotently** (option c). Works pre- and post-hook-first ship with zero new code. |

## Implication for Settings keys (post-decision tweak)

- `reddit.full_pipeline.audio_rights.bypass` — **REMOVED from the spec.** Decision #7 makes this hard-coded; no toggle.
- `reddit.full_pipeline.url_sweep.fail_on_legacy_gcs` — stays in Settings but defaults `1` and the design treats `0` as an advanced override (not surfaced prominently). Decision #8.
- All other Settings keys from the Settings audit section stand as written.

## Next step

Yoav reads this plan, answers the 5 open questions (or accepts the recommendations), and gives go-ahead. Then implementation proceeds in this order:
1. Verify the 2026-06-19 4-artifact pipeline shipped (grep + read).
2. Live pricing check (Rule 8).
3. Schema migration (smallest, safest first).
4. Worker finisher + `pending_auto_publishes` table + cron drain.
5. Admin UI: toggle column, bulk action, detail-page banner, settings group.
6. Tests written alongside each step, full suites green before calling done.
