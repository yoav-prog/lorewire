# Never publish a story without its video

Date: 2026-07-02
Branch: `fix/never-publish-without-video` (off `origin/main` @ c8409e0)
Status: approved direction from Yoav ("this can never, ever happen. If
something fail, I want a notification section in the admin, but never
publish this way!") after the incident below.

## The incident

On 2026-07-02 at 07:28:42 and 07:29:10 UTC, two stories went live on
production with `stories.video_url = NULL`:

- `1mvhekn` "DOLLAR TREE SPONSORSHIP"
- `1nkq58q` "SURVIVOR BENEFITS BATTLE"

The public reader (`/v/[slug]`) plays `stories.video_url`. With it NULL,
the Watch tab fell back to the audio+hero experience — a published story
with no watchable video on a video-first product.

Both stories had a COMPLETED short render sitting in GCS since
2026-06-21 (`short_renders.status='done'` with a live `output_url`).
The failure was the copy step: nothing ever wrote that URL onto
`stories.video_url`. The publish gate then let them through because:

1. `evaluatePublishReadiness` dropped `video_url` as a prerequisite on
   2026-06-19 (when long-form video was retired —
   `_plans/2026-06-19-no-long-form-video-for-reddit-jobs.md`).
2. `evaluateAssetCompleteness` checks the `short_renders` row (proof a
   video EXISTS in storage) but never checks that the URL landed on the
   story row (proof the reader can PLAY it).

The stories were flagged by the bulk "Complete & publish" flow and the
`/api/auto_complete_publish` cron published them. Gate said ready; the
column the frontend reads was empty.

Immediate remediation (done live, before this branch): both rows got
`video_url` + `duration` applied from their latest done render — the
exact write `applyShortToStory` does. Verified on production pages.

Why the copy was missed historically is not fully provable from
surviving rows (the June-21 job predates several finisher iterations).
The fix below closes every variant of the class rather than the one
historical path.

## Goals

1. It must be IMPOSSIBLE for a story to reach `status='published'`
   without a non-empty `stories.video_url`. Fail closed at every layer.
2. When an auto-publish cannot complete, the operator sees it in a
   dedicated admin notification surface — not just in Vercel logs.
3. The dominant transient (render done, copy missed) self-heals instead
   of blocking, so the fix does not create new manual work.

## Approach (chosen)

Defense in depth, three layers plus a notification surface:

1. **Gate** — `evaluateAssetCompleteness` gains a `video_url` gate:
   `stories.video_url` must be non-empty for `ready: true`. This is the
   single choke point shared by the manual publish action, the bulk
   action, and both auto-publish crons.
2. **Self-heal** — when `video_url` is among the missing gates and a
   done short render with an `output_url` exists, apply it via the
   existing `applyShortToStory` write and re-evaluate once. Wired into
   both drains (`lib/auto-publish.ts` and
   `/api/auto_complete_publish`). This turns the exact incident class
   into a successful publish.
3. **Hard guard** — `repo.ts::setStatus` refuses the flip to
   `'published'` when `video_url` is empty (throws, same contract as the
   existing fixture guard). Catches any path that bypasses the gate,
   including manual status flips and future code. Submission-origin
   stories are EXEMPT: the poll-only approval mode publishes them as
   text polls with no render spend by design
   (lib/submission-promote.ts, plan 2026-06-29-user-submitted-stories),
   via the same early-return that exempts them from the fixture guard.
   The incident class — Reddit/pipeline stories — is fully covered.
4. **Admin notifications** — new `admin_notifications` table + lib +
   sidebar entry with unread-count badge (mirrors the Submissions badge
   pattern) + `/admin/notifications` page. Writers: the
   `auto_complete_publish` give-up path (attempt cap reached) and the
   `auto_publish_full_pipeline` blocked path. Deduped by an unread
   `dedupe_key` so cron retries don't spam.

## Alternatives rejected

- **Gate on `short_renders` only (status quo)** — proven broken by this
  incident: it validates that a video exists in storage, not that the
  story can play it.
- **Frontend fallback (hide the Watch tab when `video_url` is NULL)** —
  treats the symptom; the story would still publish incomplete and
  socials would still fire. The publish must fail closed instead. The
  existing audio fallback in `/v/[slug]` stays as-is.
- **Notifications via e-mail/Slack** — external dependency + cost for
  v1; the admin badge is where the operator already lives. Can be added
  later as a delivery channel on top of the same table.
- **Deriving the notification list from job/render tables (no new
  table)** — the give-up path clears its flag and resets counters, so
  the failure evidence is gone by the time the operator looks; and
  cross-source UNIONs make dismissal state impossible. A small
  append-only table is simpler and truthful.

## Not in scope (deliberate)

- Python-side writers (story job failures already surface on the Live
  runs page; wiring them into notifications is a follow-up).
- Backfill sweep for OTHER data inconsistencies — a one-off query
  confirmed only the two incident stories were affected; both fixed.
- Retiring the 2 fixed stories' stale `character_base_url` temp URLs in
  render props — irrelevant to the rendered MP4s.

## Security

- New server actions (`countUnreadAdminNotificationsAction`, mark-read
  actions) all gate on `requireCapability("content.manage")`, matching
  sibling badge/queue actions.
- `notifyAdmin` writes only server-derived values; no client input
  reaches the table. `detail` is JSON-stringified server-side.
- The crons keep their CRON_SECRET Bearer auth; no new routes.
- Fail-closed publishing is itself the security posture: a half-built
  story can no longer become public content.

## Observability

- Gate: the new `video_url` code appears in the cron's structured
  `missing` logs and in `details.video_url_present`.
- Self-heal: `[auto-complete-publish-cron video_url_heal]` /
  `[auto-publish video_url_heal]` log lines with `{ story_id, applied }`.
- Notifications lib: `[admin notify] created|deduped|failed` with the
  full row context.
- Hard guard: throws with a message naming the story id and the empty
  column.

## Settings

- No new settings. The existing `auto_publish.enabled` kill switch and
  `auto_publish.max_attempts` cap already control the drain. A
  notification mute/retention knob is intentionally deferred until the
  volume justifies it (expected: near-zero rows).

## Testing

- `asset-completeness.test.ts`: fixture gains `video_url`; new cases —
  missing `video_url` flags the gate even with a done render; empty
  string counts as missing.
- `auto-publish.test.ts`: fixture gains `video_url`; new cases — a
  story with a done render but no `video_url` self-heals (publishes AND
  writes the column); a story with neither stays blocked with
  `video_url` in `missing`.
- `repo-set-status.test.ts` (new): `setStatus('published')` throws on
  empty `video_url` (fails on old code, passes on new); succeeds when
  set; non-publish statuses unaffected.
- `admin-notifications.test.ts` (new): create, unread dedupe, read rows
  don't dedupe, markRead/markAllRead, count.
- Full `vitest run` green before commit.

## Deploy

- PR from `fix/never-publish-without-video` into `main`; normal flow
  (merge → Vercel deploys main). No env, schema is additive
  (`CREATE TABLE IF NOT EXISTS` via ensureSchema on boot).
- Rollback: revert the merge commit. The data hotfix stands on its own.
- No push/merge without Yoav's explicit go-ahead (rule 19).
