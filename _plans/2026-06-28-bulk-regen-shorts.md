# Bulk regen existing shorts to the latest voice

Date: 2026-06-28
Owner: Yoav
Status: approved, executing

## Why

The clarity / POV / hook-charge prompt changes landed today and are locked in for every NEW short generated from now on (per _plans/2026-06-28-content-clarity-bar.md and the locked brand-voice memory). But the ~30 published shorts on the site were generated with the OLD prompt and still carry weak hooks, first-person narration, and symptom-not-loss openings.

Yoav wants two things in the admin so he can update existing shorts to the new style on his own schedule:

1. **Multi-select bulk regen** — pick any subset of stories from the content list, hit a bulk action, and queue them all for full short re-render.
2. **One-click "regenerate ALL published shorts"** — a single button that queues every published story's short for re-render. The common case is "I want all 30 updated to the new voice."

Both run through the existing short-render queue + worker, so we don't invent a new pipeline.

## Goals

- Add a new `"short"` target to the existing `bulkRegenerateContentAction` so multi-selected stories can be queued for short re-render in one click.
- Add a one-click "Regenerate all published shorts to latest voice" button on `/admin/content` that pre-selects every published story with an existing short and opens the standard cost-preview modal.
- Cost surfaced before firing (per global rule 8). The modal already does this for other targets; the new target plugs into the same `REGEN_TARGET_META` shape.
- Errors mapped per-story and surfaced in the existing result banner. No story silently fails.

## Constraints

- Mirror the existing target pattern in `bulkRegenerateContentAction` (lines 3738–3881). Don't invent a parallel server action.
- Reuse `enqueueShortRender(storyId, null, null, userId, { force: true })` — the same primitive the single-story "Restart entire pipeline" button calls on `/admin/videos/[id]/`.
- No new DB columns, no schema migration. The `short_renders` queue already carries everything we need.
- No daily-cap on manual bulk regen (the existing `shorts.auto.daily_cap` setting is for the AUTO path, requested_by='auto'). Manual bulk is operator-driven; the cost-preview modal is the safety bar.
- No `prompt_version` column for now. If we want to track which renders were on which prompt version in the future, that's a separate PR. The current ask is the one-time backfill.

## Chosen approach

### Server action — `lorewire-app/src/app/admin/actions.ts`

1. Extend `BulkRegenTarget` and `BULK_REGEN_TARGETS` to include `"short"`.
2. Add a new switch branch in `bulkRegenerateContentAction` for target === "short":
   - Skip if `item.kind === "article"` (`not-a-story`)
   - Load the story row; skip if not found (`not-found`)
   - Skip if `story.body` is empty (`empty-body`) — `generate_short_assets` needs source text
   - Call `enqueueShortRender(item.id, null, null, session.userId, { force: true })`
   - On race / already-running, map to `pipeline-already-running` (reuse existing reason string for consistency with the operator's mental model)
   - On other errors, pass the message through
   - Revalidate `/admin/videos/${item.id}` (the short editor page) and `/admin/content` (the list)

### `REGEN_TARGET_META` — `lorewire-app/src/app/admin/(panel)/content/ContentList.tsx`

Add the new target entry:

```ts
short: {
  label: "Short video (to latest voice)",
  verb: "Regenerate short video",
  perStoryHint: "~$1.13 per story (LLM + ~22 images + voice + render)",
  body: "Re-runs the full short pipeline using the current brand voice rules: fresh script (third-person narrator, hook names the loss directly), fresh scene art, fresh narration, fresh MP4. Replaces the existing MP4 when done. In-flight renders are skipped.",
},
```

The existing dropdown picker auto-discovers it from `Object.keys(REGEN_TARGET_META)`; no other UI plumbing needed.

### One-click "Regenerate ALL published shorts" button

Above the content list, in the same area as the existing "New article" / "Import from Sheets" header actions, add:

```
[ Regenerate ALL published shorts (N) ]
```

Where N is the live count of `rows.filter(r => r.kind === "story" && r.status === "published" && r.has_short)`. When clicked, it opens the existing `RegenConfirmModal` pre-targeted to `"short"` with all qualifying rows. The user confirms; the rest of the existing flow runs.

This is two clicks total (button → confirm) for the most-common case. The dropdown path remains for partial selections.

### `has_short` flag on ContentRow

The button needs to know which stories actually have a short to regen. Two options:
- (a) Check `video_url` truthy (existing column, no schema change).
- (b) Add a derived `has_short` computed at query time.

Going with (a) since `video_url` already populates for stories with shorts and we don't add new query surface.

## Alternatives rejected

1. **New dedicated `/admin/(panel)/shorts/page.tsx` list page.** Cleaner conceptually but ~5x more code (new route, layout, data source, list component). The existing content list already does multi-select + filter-by-status + per-row checkboxes. Extending it is the smaller, lower-risk change. Revisit if the shorts management story diverges enough from articles/stories to warrant separation.

2. **Add a `narration_prompt_version` column + only regen stale shorts.** The clean long-term move. Skipped now because: (a) the schema migration adds friction we don't need for a one-time 30-story backfill; (b) we'd need to also stamp the version on every existing row, which is its own backfill; (c) the user explicitly said "regenerate all" — they're OK with the "regen everything" model for now. Worth doing before the NEXT prompt tightening.

3. **Throttle manual bulk regen with a daily-cap setting.** Skipped — the cost modal is sufficient friction. 30 stories at ~$1.13 each is ~$34, surfaced before commit. If operator wants to throttle, they can select a subset.

4. **Send the bulk to Cloud Run for parallel rendering.** Current worker drains the queue serially (~6-8 min/short → ~3-4 hours for 30). Parallelism would speed this up but adds substantial complexity (Cloud Run config, per-render budget tracking, race-safe poll updates). Out of scope for this PR.

## Open questions

- None right now. The Phase-2 enhancement (`prompt_version` tracking) is a known future PR — flagged in alternatives.

## Sections required by the global rules

### Security
- Server action calls `requireCapability("content.manage")` — same gate as the existing bulk action. No new auth surface.
- Idempotency key on `short_renders` (story_id, config_hash) means a double-click on the bulk button doesn't double-charge: the second enqueue is a no-op.
- `force: true` overwrites in-flight renders — but per the existing `enqueueShortRender` logic, only when the row is in `done`/`error`/`cancelled` state. An actively `rendering` row is preserved (per memory in `short-render-queue.ts`).
- Cost-surface in the modal is required, not optional. A new target type with no `perStoryHint` would render as `undefined × N stories` — typed `Record<BulkRegenTarget, …>` prevents that.

### Observability
- Logs already exist: `[content bulk regen] start` (target + count) and `[content bulk regen] done` (ok + failed). The new branch logs `[content bulk regen] failed` per-story on errors. The new target shows up in those logs without code changes.
- Per-story render lifecycle is already logged by the worker (`[short queue claim/done/error]`), so the operator can grep the worker log to follow the 30-story drain.

### Settings
- No new settings. The bulk action is explicit and operator-driven; defaults would either get in the way or become invisible knobs that drift.

### Testing
- Unit test in `lorewire-app/src/app/admin/__tests__/actions.test.ts` (or wherever bulkRegenerateContentAction tests live; create if missing): the new `"short"` target validates correctly and dispatches `enqueueShortRender` per item with `force: true`. Mock `enqueueShortRender` so no real DB writes happen in the test.
- Smoke test: boot dev server, navigate to /admin/content, verify (a) "Regenerate short video" appears in the bulk action dropdown, (b) the "Regenerate all published shorts" button appears in the header, (c) clicking either opens the cost-preview modal with the right verb / count / cost line. Do NOT confirm-submit in the smoke test — that fires real LLM/image calls.

### Deploy
- Branch off `main`. The current branch (`fix/homepage-rails-vote-and-top10`) has the unrelated rail work + the clarity-bar prompt PR; this bulk-regen PR is a follow-up to the clarity-bar PR. Two paths:
  - (a) Wait for the clarity-bar PR to merge, then branch off main for the bulk regen PR.
  - (b) Open both PRs in parallel; merge clarity-bar first.
- Either way, this PR does not modify any prompt content — it only adds an admin affordance to re-trigger the existing pipeline. Safe to ship independently once the clarity-bar prompt is in.
- No Vercel manual promotion. Standard flow: PR → CI → merge to main → Vercel deploys.
