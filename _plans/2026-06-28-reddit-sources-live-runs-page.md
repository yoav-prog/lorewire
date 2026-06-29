# Reddit Sources — Live Runs page

**Date:** 2026-06-28
**Branch:** `feat/reddit-sources-live-runs` (new, branched off current main snapshot — see Deploy section)
**Status:** Draft — awaiting Yoav's approval before any code lands

## The problem we are solving

Today, after the admin clicks **Process N** on `/admin/reddit-sources`:

1. The list page does not auto-refresh, so the status chips on the queued/processing rows stay frozen until the admin manually reloads. There is no visible signal that anything is moving.
2. The only live progress surface is the per-row review page at `/admin/reddit-sources/[reddit_id]`, which polls every 2 seconds via [StoryJobEventTimeline.tsx](lorewire-app/src/app/admin/(panel)/reddit-sources/[reddit_id]/StoryJobEventTimeline.tsx). To watch 5 in-flight rows the admin needs 5 tabs and has to switch between them.
3. The banner copy ("Click into any row to watch its live timeline") is a text instruction. Nothing in the UI pulls the admin's eye toward what they just enqueued.

Net effect: admin queues a batch, can't tell what's running, opens N tabs to verify, and falls back to the worker terminal logs to see the full event stream. That's the friction Yoav called out.

## Goal

A single screen where the admin can:

- See every in-flight story job at once (across all reddit sources, regardless of which list page they're filtered to).
- See the full event timeline of each in-flight job streaming live, without leaving the page.
- Drill into the per-row review page only when they want the source/story panes — not just to watch progress.
- Land here automatically after clicking Process, so the next action after "I just enqueued N rows" is obvious.

## Non-goals

- No mutations on this page (no Stop, no Re-process, no Skip). Those live on the list/detail pages where row-context exists. This page is read-only by design — it's a watch surface.
- No filtering / search UI in v1. The page is "what's running NOW." If nothing is running, the page says so.
- No streaming protocol (SSE / WebSocket). Polling matches the existing per-row timeline pattern and stays consistent with the rest of the admin observability layer ([content/AutoRefresh.tsx](lorewire-app/src/app/admin/(panel)/content/AutoRefresh.tsx), [StoryJobEventTimeline.tsx](lorewire-app/src/app/admin/(panel)/reddit-sources/[reddit_id]/StoryJobEventTimeline.tsx)).
- No retention of finished jobs in this view beyond a short tail (see Architecture). Historical jobs already have a home on the per-row review page.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ /admin/reddit-sources/live  (new route)                         │
│                                                                 │
│   Server component (page.tsx):                                  │
│     • requireCapability("content.manage")                       │
│     • Initial server render: snapshot of active jobs            │
│     • Mounts <LiveRunsClient/>                                  │
│                                                                 │
│   Client component (LiveRunsClient.tsx):                        │
│     • Polls listActiveJobsWithEventsAction every 2s             │
│     • Stops polling when tab is hidden (visibilitychange)       │
│     • Renders one card per active job, each card shows:         │
│       - subreddit + title (link to /admin/reddit-sources/[id])  │
│       - current job status chip                                 │
│       - phase indicator (latest event name + message)           │
│       - elapsed time since `requested_at`                       │
│       - inline scrollable event log (last 50 events)            │
│     • Empty state: "No active runs. Queue some rows from the    │
│       Reddit Sources list."                                     │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │
        ┌─────────────────────┴─────────────────────┐
        │ listActiveJobsWithEventsAction            │
        │ (new server action in app/admin/actions)  │
        │                                           │
        │   1. SELECT active story_jobs             │
        │      (status IN queued/processing) +      │
        │      latest finished within last 15 min   │
        │      JOIN reddit_source for title/subred  │
        │   2. SELECT story_job_events FOR those    │
        │      job_ids, latest 50 each              │
        │   3. Group server-side → ActiveJobView[]  │
        └───────────────────────────────────────────┘
                              ▲
                              │
            existing story_jobs + story_job_events
            tables (no schema changes)
```

### Why include "finished within last 15 min" in the active set

When a job finishes, the admin's eye is still on the page. Yanking the card the instant `status='done'` lands feels like the job disappeared into the void. Holding it on the page for ~15 minutes lets the admin see the final "finished" event, the cost, and the resulting `story_id` link. After the grace window the card drops; the per-row review page is the long-term home.

### Why polling, not SSE

The existing observability layer in the admin uses polling everywhere (per-row timeline, content list AutoRefresh, image render queue). Introducing SSE for one page adds a runtime concern (long-lived connections on Vercel functions) for no UX win on a watch surface where 2-second cadence is plenty. We can revisit if/when we have a multi-page need.

### Why a dedicated route over an above-table panel

Yoav picked Option C explicitly. The dedicated route also:
- Survives the admin navigating away from the list filters they had set up.
- Gives room for a per-card event log without squashing the table layout.
- Pairs cleanly with a sidebar "Live runs" badge that pulls the admin's eye even from unrelated pages (e.g. they go to Settings to tweak something while a batch processes).

The tradeoff vs. Option B (above-table panel): one extra route + nav entry to maintain. Accepted.

## Files touched

### New files
- `lorewire-app/src/app/admin/(panel)/reddit-sources/live/page.tsx` — Server component, capability-gated, mounts the client island.
- `lorewire-app/src/app/admin/(panel)/reddit-sources/live/LiveRunsClient.tsx` — Polling client component; renders the active-job cards + empty state + last-updated indicator.
- `lorewire-app/src/app/admin/(panel)/reddit-sources/live/LiveJobCard.tsx` — Single card for one active job (header + status chip + inline event log).
- `lorewire-app/src/lib/story-jobs-live.ts` — New server-only data module. Reads. No writes. Contains:
  - `type ActiveJobView` (the JSON shape returned to the client).
  - `listActiveJobsWithEvents(opts)` — the join query described above.
- `lorewire-app/src/app/admin/(panel)/reddit-sources/live/__tests__/LiveRunsClient.test.tsx` — render tests (empty state, populated state, polling stop on tab hidden).
- `lorewire-app/src/lib/__tests__/story-jobs-live.test.ts` — unit tests for the data function (active subset, finished grace window, event ordering).

### Modified files
- `lorewire-app/src/app/admin/actions.ts` — add `listActiveJobsWithEventsAction()` thin wrapper. `requireCapability("content.manage")`. No mutation surface added to this file.
- `lorewire-app/src/app/admin/(panel)/reddit-sources/page.tsx` — banner CTA: when `enqueued > 0`, add a primary "Watch live →" link to `/admin/reddit-sources/live`. Existing copy ("Click into any row to watch its live timeline") becomes secondary fallback for skipped/legacy paths.
- `lorewire-app/src/app/admin/AdminSidebar.tsx` — add a new sidebar item under Reddit Sources: "Live runs" with `activePrefixes: ["/admin/reddit-sources/live"]` and a count badge driven by a tiny new client component (see below). Capability-gated on `content.manage`.
- `lorewire-app/src/app/admin/SidebarLiveBadge.tsx` (new, but lives next to AdminSidebar.tsx) — polls a lightweight `countActiveStoryJobsAction` every 15 seconds (only when authed; visibility-aware). Renders a dot + number next to "Live runs". Existing `countPendingStoryJobs` in [story-jobs.ts](lorewire-app/src/lib/story-jobs.ts) is the data source.

### Not touched
- Worker code (`pipeline/story_jobs_worker.py`) — the existing event log calls are already what we're surfacing. No worker changes.
- Schema — no migrations. `story_jobs` and `story_job_events` already carry everything we need.
- Per-row review page — keeps its existing inline timeline. The two surfaces complement each other.

## Security (rule 13)

What's sensitive: this page surfaces queue state, event messages, error payloads (which can contain LLM error text including parts of prompts/responses), and reddit source titles. All of this is already gated as admin-only across the rest of the panel.

What we do:
- Every server action and the page itself call `requireCapability("content.manage")` at entry. Same gate as the existing per-row timeline.
- All data is read-only. No bulk action surface, no IDs accepted from the client, no query parameters that touch the DB. The client polls a parameterless action and receives a snapshot.
- Result-size caps applied server-side: max **50 active jobs** returned per poll, max **50 events per job**. Hard ceiling prevents a degenerate state (queue blew up to 1000 jobs) from blowing the response payload and the client render.
- Events table already excludes raw secrets — the existing worker logging is what we surface, no new payload surface.
- The sidebar badge action returns only an integer count. No row leakage from unauthenticated probes (the action's `requireCapability` returns/throws before the count is computed).

What we deliberately don't log: payload contents do not get echoed to the client `console.info` namespaced logs. Counts and event names only — see Observability.

## Observability (rule 14)

Per rule 14, every meaningful step gets a namespaced log. Concrete shape:

Client (browser console):
- `console.info("[reddit-sources live mount]", { initialJobCount })` — once when LiveRunsClient mounts.
- `console.info("[reddit-sources live poll]", { jobCount, eventCount, durationMs })` — every poll tick.
- `console.warn("[reddit-sources live poll error]", { err })` — on poll failure (network/action error). Errors are also surfaced in-UI in a small "stale data — last update X ago" row.
- `console.info("[reddit-sources live visibility]", { visible })` — on visibilitychange (pause/resume).
- `console.info("[sidebar live badge poll]", { count })` — sidebar badge tick.

Server (action logs):
- `console.info("[reddit-sources live action] query", { activeCount, finishedRecentCount, totalEvents })` — every call to `listActiveJobsWithEventsAction`.
- `console.info("[sidebar live badge action] count", { count })` — every call to the count action.

No raw event payload fields, story bodies, or reddit titles get logged on the server beyond what's already logged by the worker. The browser-side logs include counts only — not payloads — so a screenshare/Loom doesn't leak content.

## Settings audit (rule 15)

Walked through the feature for hardcoded choices the admin might want to control:

| Choice | Default | Expose as setting? | Why |
|---|---|---|---|
| Poll interval | 2 seconds | **No** | Matches the existing per-row timeline. Exposing it gives the admin a knob with no real use case. Revisit if/when the queue routinely runs > 10 jobs simultaneously. |
| Finished-grace window | 15 minutes | **No** | Same — a single sane default. Hardcode now; cheap to expose later if the admin ever asks. |
| Max active cards on screen | 50 | **No** | This is a backstop, not a UX knob. If we ever hit it the right answer is to investigate, not to raise it via settings. |
| Sidebar badge poll | 15 seconds | **No** | Background indicator; finer granularity costs DB hits without UX benefit. |
| Show / hide finished cards | On (for grace window) | **Yes (URL param, not Settings)** | Use `?finished=hide` for the admin who wants a clean "only what's running now" view. URL param keeps it shareable and out of the Settings layer. |

No new entries in the `/admin/settings` hub. The single user-facing knob is the URL param. Documented as "Tip: append `?finished=hide` to hide the recently-finished cards" in the page itself.

## Testing (rule 18)

### Unit tests

- `lorewire-app/src/lib/__tests__/story-jobs-live.test.ts`
  - Returns active jobs (status queued/processing) — golden path.
  - Includes finished jobs within the 15-minute grace window.
  - Excludes finished jobs older than 15 minutes.
  - Returns events ordered oldest-first per job.
  - Respects the 50-job and 50-events-per-job caps.
  - Handles the empty case (no active jobs, no recently finished).

- `lorewire-app/src/app/admin/(panel)/reddit-sources/live/__tests__/LiveRunsClient.test.tsx`
  - Renders the empty state when the action returns `[]`.
  - Renders one card per active job from a mocked initial snapshot.
  - Re-renders when a poll returns updated event lists (mock the action).
  - Stops polling when `document.visibilityState === 'hidden'`; resumes on visible.
  - Respects the `?finished=hide` URL param.

- `lorewire-app/src/app/admin/__tests__/SidebarLiveBadge.test.tsx`
  - Renders no badge when count is 0.
  - Renders dot + number when count > 0.
  - Stops polling when tab is hidden.

### Integration / end-to-end

- Manual smoke test before calling the task done:
  1. Local dev: queue 1 row, navigate to `/admin/reddit-sources/live`, confirm one card appears, events stream in as the worker progresses, card hangs around for 15 minutes after finish.
  2. Queue 0 rows, navigate to `/admin/reddit-sources/live`, confirm empty state copy.
  3. Open the page in two tabs; confirm both poll at 2-second cadence and stop when tab is backgrounded.
  4. Click "Watch live →" from the post-Process banner on the list page; confirm landing.
  5. Confirm sidebar badge appears + count is accurate while jobs are in flight.
  6. Confirm the `?finished=hide` param removes the grace-window cards.

### Bar to call this done

- All listed unit tests written and green.
- `npm --prefix lorewire-app run test` green for the whole suite (not just the new tests).
- Manual smoke test 1-6 above pass.
- `npm --prefix lorewire-app run typecheck` clean.
- `npm --prefix lorewire-app run lint` clean for the new files.

## Deploy (rule 19)

### Current production state — must be verified before any push

Per `lorewire-app/AGENTS.md` we are in the inverted state where Vercel's Production Branch tracks a non-main branch. Before I push or merge anything:

1. `git fetch origin`
2. Read the Vercel dashboard (or ask Yoav) to confirm which branch is currently the Production Source.
3. Check divergence:
   ```
   git log origin/main..origin/<production-source-branch> --oneline
   ```
4. Report findings here in the plan or in chat before any push.

### Proposed flow

1. Branch off the **current production-source branch** (not main, if main is still behind). Name: `feat/reddit-sources-live-runs`.
2. Implement on that branch in isolated commits per concern:
   - Commit 1: `story-jobs-live.ts` data layer + unit tests.
   - Commit 2: `listActiveJobsWithEventsAction` + `countActiveStoryJobsAction` server actions.
   - Commit 3: `/admin/reddit-sources/live` route, page, client components, card.
   - Commit 4: Banner CTA on the list page + sidebar item + badge.
   - Commit 5: Test pass — unit tests for client components + smoke test pass-off.
3. Push the branch. Vercel will build a **preview**. **Do not promote it manually** — that would force-deploy to production from a non-tracked branch (the 2026-06-23 incident pattern).
4. Open a PR targeting the production-source branch (or main if main has caught up by then — Yoav decides).
5. Yoav reviews the preview deployment. If green, the PR merges via the normal flow and production picks it up via the standard Production Branch tracking. Manual UI promotion stays off the table.

### Rollback

This is a pure additive change: one new route, one new sidebar item, one banner string edit, two new read-only actions. Rollback = revert the merge commit. No schema, no data migration, no env vars, no breaking change to existing surfaces.

If the page misbehaves but the rest of the admin is fine, the lowest-impact emergency lever is to remove the sidebar nav item + redirect `/admin/reddit-sources/live` to `/admin/reddit-sources` in a one-line patch. The underlying actions can stay (they're harmless reads). That hides the feature without a full revert.

### What I will NOT touch

- `main` directly (no direct push, ever).
- Vercel's Environments → Production setting.
- The "Promote to Production" / "Redeploy" / "Rebuild" buttons in the Vercel UI.
- Any other feature branch (`feat/r2-media-migration`, `feat/multi-platform-shorts-publisher`, etc.).
- The `story_jobs` / `story_job_events` schemas.
- Worker code in `pipeline/`.

## Alternatives rejected

**Option A — Auto-refresh the list view + filtered banner link.** Cheapest. Fixes the "frozen status chip" half of the problem but leaves the "5 tabs to watch 5 rows" half intact. Rejected because it doesn't deliver an aggregated view.

**Option B — Above-table activity panel.** Solves both gaps with a single component, no new route. Recommended in the initial discussion. Rejected by Yoav in favor of Option C because the dedicated route gives breathing room for full per-card event logs and lets the sidebar carry an at-a-glance "Live runs (N)" badge from anywhere in the admin, including pages that aren't the reddit list.

## Open questions

1. **Production-source branch confirmation** — I need to know which branch is currently the Vercel Production Source before I open a PR. This is a pre-flight check, not a code question.
2. **Card density** — for a typical batch of 5-10 in-flight jobs, do you want each card to show the full last-50 events scrollable (more screen space, less switching) or collapse by default to header + latest event + "expand"? I'll default to **collapsed-with-latest-event-shown** unless you say otherwise — it scales to a 20-row batch without becoming a wall of text.
3. **Finished-grace window** — I picked 15 minutes. Is that too long for your workflow? A 5-minute window would feel snappier; a 60-minute window would let you walk away and come back. Default stands at 15 unless you redirect.
