# Bulk Complete-and-Publish (video stories)

**Date:** 2026-06-25
**Branch:** `feat/wires-poll-panel-compact` (will branch off main into `feat/bulk-complete-and-publish`)
**Status:** Proposed — awaiting approval

## Goal

From the admin content list (`/admin/content`), a user selects N video stories and clicks one button. The system:

1. For each selected story, computes the set of missing assets.
2. Enqueues every missing asset through the existing async pipeline.
3. Marks each story `auto_publish_when_ready = 1`.
4. A 2-minute cron walks flagged stories; the moment a story passes the full readiness gate, the cron flips `status = 'published'` and enqueues the four social-publish rows (FB / IG / YT / TikTok).
5. Existing per-platform retry crons drain the queues and post.

The operator's job ends at the click.

## Requirements (confirmed with user)

- **Asset gates required for "ready":** article body, hero image, per-platform thumbnails (FB/IG/YT/TT hero variants), short video render, voiceover render, every scene image, an attached enabled poll.
- **Architecture:** flag-on-story + watcher cron (rejected: blocking server action; rejected: enqueue-and-come-back).
- **Targets:** all four socials, every time.
- **In scope this PR:** the UI button, the action, the new column, the readiness function, the watcher cron, observability, settings (defaults), tests.
- **Out of scope:** retries for permanently failed assets beyond a soft cap; multi-tenant rules; per-story platform whitelist (we picked "all four"); reuse for articles (action stays video-story-only this round).

## Alternatives considered and rejected

| Option | Why rejected |
|---|---|
| Long-running server action that loops until renders finish then publishes | Vercel kills past ~15min; short renders can take longer. Confirmed unsuitable. |
| Enqueue-only, no auto-publish; operator comes back to click PUBLISH TO SOCIALS | Not actually "automatic"; user explicitly asked for one-click set-and-forget. |
| Per-platform target whitelist on the story model | More UX flexibility but no operational pain point today justifies the extra column + UI. Can be added later without breaking the watcher. |

## Chosen approach (the picture)

```
User clicks "COMPLETE & PUBLISH" on N selected video stories
                    │
                    ▼
  bulkCompleteAndPublishAction(items)
                    │
                    ▼
  for each story s:
    missing = evaluateAssetCompleteness(s)  // new
    enqueue each missing asset through existing primitives
    UPDATE stories SET auto_publish_when_ready = 1 WHERE id = s.id
                    │
                    ▼
  returns { flagged, alreadyComplete, skipped, errors } immediately
                    │
                    ▼
              (workers render, minutes pass)
                    │
                    ▼
  Cron /api/auto_complete_publish (every 2m)
    SELECT * FROM stories WHERE auto_publish_when_ready = 1
    for each:
      readiness = evaluateAssetCompleteness(s)
      if readiness.ready and not already published:
        setStatus(s.id, 'published')
        enqueue facebook_posts, instagram_posts, instagram_stories,
                facebook_stories, youtube_posts, tiktok_posts
              (trigger='auto', dedup-safe on render_id)
        UPDATE stories SET auto_publish_when_ready = 0
      elif readiness.attempts >= MAX_ATTEMPTS:
        log + clear flag + write to error_events for visibility
      else:
        increment attempts, leave flag set
```

## Files to touch

### New

- **`src/lib/asset-completeness.ts`** — single source of truth: `evaluateAssetCompleteness(story): { ready: boolean; missing: AssetGate[]; details: Record<AssetGate, AssetState> }`. Reuses `evaluatePublishReadiness` for body+hero, adds: short render lookup, voice render lookup, scene-image walk over `short_config.doodle_frames`, polls table query, per-platform hero variant lookup in `image_renders`.

- **`src/app/api/auto_complete_publish/route.ts`** — the new cron handler. Loops flagged stories, calls the completeness fn, on ready publishes + enqueues socials.

- **`_plans/2026-06-25-bulk-complete-and-publish.md`** — this file.

- **Tests**:
  - `src/lib/__tests__/asset-completeness.test.ts` — pure-function tests of every gate (each "missing X" case + the "all green" case + the "already published" short-circuit).
  - `src/app/admin/__tests__/bulk-complete-and-publish.test.ts` — action-level tests: nothing-missing path, hero-missing path, multi-missing path, idempotency (clicking twice does not double-enqueue), only video stories (articles refused).
  - `src/app/api/auto_complete_publish/__tests__/route.test.ts` — cron tests: ready story publishes + clears flag; not-ready story stays flagged; exhausted attempts gives up cleanly.

### Modified

- **`src/lib/schema.ts`** — append two columns to STORIES (around line 120):
  - `{ name: "auto_publish_when_ready", type: "INTEGER" }`
  - `{ name: "auto_publish_attempts", type: "INTEGER" }`
  ESLint-aligned dated comment above per existing convention.

- **`src/app/admin/actions.ts`** — add `bulkCompleteAndPublishAction(items)` next to `bulkPublishToSocialsAction` (~line 3814). Validates items are video stories; for each, calls `evaluateAssetCompleteness`; enqueues missing via existing `enqueueImageRegen` / `enqueueScenesBulk` / `enqueueVoiceRender` / `bulkEnqueueStoryJobs` primitives; UPDATEs the flag in a single row-by-row pass. Returns `{ flagged, alreadyComplete, skipped, errors[] }`.

- **`src/app/admin/(panel)/content/ContentList.tsx`** — add new button in the sticky bulk-action bar, placed BEFORE `PUBLISH TO SOCIALS`. Label: "COMPLETE & PUBLISH". Disabled when selection has 0 video stories. Confirm dialog showing N video stories + estimated AI cost (sum of per-asset cost estimates × missing assets, reusing the existing cost-hint machinery from `bulkRegenerateContentAction`). On confirm, calls the new action, surfaces the returned counts as a toast.

- **`vercel.json`** — add the new cron entry after the existing `auto_publish_full_pipeline` block:
  ```json
  { "path": "/api/auto_complete_publish", "schedule": "*/2 * * * *" }
  ```

- **`src/lib/auto-publish.ts`** — extract the "enqueue all four social rows for the latest short render" sub-routine so the new cron can call it without duplicating logic. Keep `publishStoryIfReady` working as today for the manual path.

- **`src/lib/reddit-source.ts`** — leave `evaluatePublishReadiness` alone; the new completeness fn calls it as the body+hero gate, then adds the rest. Avoids breaking the existing manual publish path.

## Security (rule 13)

- **AuthZ:** the new bulk action sits in `src/app/admin/actions.ts`, which is already admin-gated. Confirm the same gate guards it — do NOT introduce a new entry that bypasses the admin session check.
- **Cron entry point:** `/api/auto_complete_publish` MUST require the `CRON_SECRET` header check that the existing cron routes use (`auto_publish_full_pipeline`, `drain_story_jobs`). Pattern is established — copy it exactly.
- **No new secrets handled.** Social tokens are already in env; the new cron only enqueues rows, the per-platform drain crons hold the credentials.
- **Cost / runaway protection:** hard cap `MAX_AUTO_PUBLISH_ATTEMPTS = 12` (24 minutes of retries at 2m). After that, clear the flag, write to `error_events`, surface in admin. Prevents stuck flag → publishes pile up after a fix lands.
- **Idempotency:** social-post enqueue uses dedup on `(story_id, render_id)` so re-flag + re-publish does NOT double-post. Need to verify the existing UNIQUE constraints in `facebook_posts` / `instagram_posts` / `youtube_posts` / `tiktok_posts` before relying on this; if missing, add `INSERT … ON CONFLICT DO NOTHING` in the cron's enqueue call.
- **Refuse already-published:** belt-and-suspenders check inside the cron — if `stories.status = 'published'`, just clear the flag, never re-post.
- **Article publish path untouched:** action explicitly refuses articles. Articles have a different publish gate (`publishArticleIfReady`) and we don't want one button to silently flip into both.

## Observability (rule 14)

Namespaced logs at every step. All in `console.info`/`console.warn`/`console.error` with `[bulk-complete-publish …]` prefix on the action side and `[auto-complete-publish-cron …]` on the cron side.

- `[bulk-complete-publish click] { selectedCount, videoStoryCount, articleCount, userId }`
- `[bulk-complete-publish gate] { storyId, ready, missing }` (per story)
- `[bulk-complete-publish enqueue] { storyId, asset, jobId | renderId }` (per missing asset)
- `[bulk-complete-publish flag-set] { storyId }` (per story)
- `[bulk-complete-publish result] { flagged, alreadyComplete, skipped, errors }`
- `[auto-complete-publish-cron tick] { flaggedCount }`
- `[auto-complete-publish-cron gate] { storyId, ready, missing, attempts }`
- `[auto-complete-publish-cron publish] { storyId, renderId, platforms }`
- `[auto-complete-publish-cron giveup] { storyId, attempts, lastMissing }`
- `[auto-complete-publish-cron clear] { storyId, reason }`

On the worker / Python side, the existing render workers already log; no changes needed.

## Settings (rule 15)

Add a new Settings group **"Auto-publish"** (if no existing group fits — check `src/app/admin/(panel)/settings/`):

- **`autoPublishEnabled`** (default: `true`) — global kill switch for the cron. When off, flagged stories sit until enabled. Useful for emergencies.
- **`autoPublishMaxAttemptsPerStory`** (default: `12`) — give-up cap.
- **`autoPublishTargetPlatforms`** (default: `["facebook","instagram","instagram_stories","facebook_stories","youtube","tiktok"]`) — opens the door to user choice without per-story complexity. UI: checkbox list. Defaults to all six surfaces (Reels + Stories where applicable).
- **`autoPublishDailyBudgetCents`** (default: `null` = unlimited) — hard daily cap; cron stops enqueueing socials past it. Reuses the existing daily-budget infrastructure used by `bulkRegenerateContentAction`.

Deliberately NOT exposed: the cron schedule (live as a code constant in `vercel.json`), the namespaced log prefix.

If no settings layer exists for "Auto-publish," flag it and propose adding the group rather than hardcoding.

## Testing (rule 18)

- **Unit:** `evaluateAssetCompleteness` covers every gate independently — one test per (article-body-missing, hero-missing, short-missing, voice-missing, single-scene-missing, all-scenes-present, poll-missing, poll-disabled, per-platform-thumbnail-missing, fully-green, already-published-short-circuit).
- **Action:** `bulkCompleteAndPublishAction` — golden path (all missing, flags set + enqueues correct), idempotency (second click is a no-op for already-flagged), article rejection, partial selection (some video some article), zero-selection, mixed-completeness (some fully ready immediately publishable, some need everything).
- **Cron:** `auto_complete_publish/route.ts` — ready story publishes + enqueues all six socials + clears flag; not-ready story stays flagged + increments attempts; attempts-exceeded clears flag + writes error_events; auth check rejects without `CRON_SECRET`.
- **Regression:** existing tests for `evaluatePublishReadiness`, `bulkPublishToSocialsAction`, and `auto-publish.ts` must still pass unchanged. If they don't, the change broke an existing contract.
- **Run:** `npm test` (or whichever is wired) for the full suite before the PR opens. Cron handler tests must hit the real `evaluateAssetCompleteness` + a mocked DB.

If no test framework is wired for any of these files, flag it before writing the code and get approval for `vitest` (matches the Vercel/Next.js stack per Context7).

## Deploy (rule 19)

- Branch off `main` into `feat/bulk-complete-and-publish` (current branch `feat/wires-poll-panel-compact` is a different feature; do NOT pile on top).
- PR into `main`. Verify `main = production` invariant before merging per memory.
- Schema change: the new columns deploy via `ensureSchema()` on next boot (additive ALTER TABLE, no destructive ops). Confirmed safe pattern from `seo_metadata_json` precedent.
- New cron activates at first deploy. Verify `vercel.json` cron entry is correct, run `vercel inspect` after deploy to confirm scheduled function shows up.
- **Rollback path:** revert the merge PR. The new column stays in the DB (harmless when nothing reads it). The new cron entry disappears with the revert. No data migration to undo.
- **Pre-merge checklist:**
  - All tests green locally.
  - PR description includes screenshots of the new button + the confirm dialog.
  - PR description names the new cron + its schedule explicitly.
  - PR description names the new env var dependency: `CRON_SECRET` (already exists).
  - Branch is up-to-date with `main` immediately before merge (memory warns about stale-branch pushes).

## Cost (rule 8)

- **Marginal cost = sum of (missing assets × existing per-asset cost).** No new paid services; we're orchestrating existing generators.
- Hero image regen, scene image regen, voice render, short render — all already costed in the existing regenerate paths; their cost hints flow through to the confirm-dialog estimate.
- **Social posting:** no per-post fee on FB/IG/YT/TikTok; the cost is bandwidth at GCS egress, which is the same as today's manual publish.
- **Cron itself:** /api/auto_complete_publish runs every 2 min. Vercel function invocation cost is negligible (well inside the cron budget per Vercel pricing) but worth noting that we're adding one more 2-minute cron.

## Open questions

1. **Settings layer existence.** I haven't confirmed `/admin/(panel)/settings/` exists or what groups live there. If it doesn't, I'll propose a minimal "Auto-publish" settings card before hardcoding the defaults.
2. **Cost-hint reuse.** `bulkRegenerateContentAction` already returns cost estimates; I'll grep how those bubble up to the existing confirm dialog and mirror the pattern, but if the wiring is awkward I may simplify to "count of missing assets" without dollars.
3. **Per-platform hero variants.** Verification said "hero_thumbnail_from_short" image_renders rows exist; I need to confirm the exact slug-per-platform mapping (do FB and IG share a variant? Does YT need a 16:9 specifically?) so the gate check knows what to look for.
4. **`council pass` before implementation.** Per rule 11 this is a meaningful decision (new DB column, new cron, cost-bearing). I'd recommend running `llm-council` on this plan before writing code.

## Estimate

- Implementation: ~6-8 hours.
- Testing: ~2-3 hours.
- Review + iterate: ~1-2 hours.
- Total: ~one focused day.
