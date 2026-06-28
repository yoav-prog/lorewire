# Show the actual rendered MP4 duration everywhere — no more body-only badges

Date: 2026-06-29
Owner: Yoav
Status: Approved (option A from chat 2026-06-29; user also asked for backfill of existing stories)
Branch: `feat/actual-mp4-duration` (worktree off `feat/multi-platform-shorts-publisher`)

## Why this exists

A user-reported bug: the homepage poster cards (mobile + desktop) show a
duration that's noticeably shorter than what the story watch page
player shows. Repro on *The Dress Disaster*: card pill reads **0:35**,
player reads **0:44**. The ~9 s gap is the intro + outro + post-roll
hold that the splice/concat layer adds in Cloud Run.

The story page is honest because [StoriesViewer.tsx:363-368](../lorewire-app/src/components/stories/StoriesViewer.tsx#L363) reads
`<video>.duration` straight off the MP4 metadata. The poster cards
([AppShell.tsx:175-176](../lorewire-app/src/components/AppShell.tsx#L175),
[DesktopShell.tsx:176-177](../lorewire-app/src/components/DesktopShell.tsx#L176))
render `story.dur`, which is `stories.duration` from the DB.

`stories.duration` is filled by:
1. **Writer** — [short-render-queue.ts:355-394](../lorewire-app/src/lib/short-render-queue.ts#L355)
   `formatFullDurationForStory` = body_ms + intro_ms + outro_ms.
2. **Reader backfill** — [homepage-data.ts:133-221](../lorewire-app/src/lib/homepage-data.ts#L133)
   `loadShortDurationsForStories` does the same math at request time
   when the column is NULL.

Both formulas miss:
- `SHORT_END_HOLD_MS` (1500 ms post-roll injected at [render_short/route.ts:60](../lorewire-app/src/app/api/render_short/route.ts#L60))
- Any ffmpeg re-encode rounding / pad / hook-first reorder padding
- Anything else the splice layer adds in the future

And they degrade to body-only when the `_last_rendered_segments`
stamp is missing (legacy rows, stamp-write failures).

The math is a lossy proxy for ground truth. The MP4 itself is ground
truth. Stop summing, start probing.

## Goals

1. Every duration badge — homepage, rails, mobile + desktop,
   PosterArt, WireCard, anywhere a badge surfaces — matches the
   actual rendered MP4 to within ±1 s.
2. New renders self-correct: the duration we display is the duration
   ffprobe reports on the spliced MP4, no math.
3. Existing rendered stories that already show a stale value get
   backfilled — the user explicitly asked for "fix existing" too.
4. The writer / reader paths stop carrying body-only fallback math as
   the primary source. Body-only stays as a defensive last resort, but
   the assembled MP4 duration wins whenever it's available.

## Non-goals

- Changing how `stories.duration` is exposed publicly (still M:SS
  string in the same column).
- Touching how the WireCard reads `<video>.duration` client-side
  (defense in depth — leave it).
- Schema migrations. Everything fits in the existing
  `short_renders.props` JSON.

## Architecture

```
Cloud Run /render
  ├── renderMedia → bodyPath
  ├── spliceWithSegments → bodyPath (replaced in place)
  ├── ffprobe(bodyPath) → durationMs                        ← NEW
  └── upload → return { url, elapsed_ms, duration_ms }      ← NEW field

Vercel render_short route
  └── result.duration_ms → finishShortRender(..., assembledDurationMs)  ← passes it through

Vercel finishShortRender
  └── merge { assembled_duration_ms } into short_renders.props          ← NEW
      (does NOT touch props.duration_ms — body length stays accurate
       for planner / re-render flows)

Cloud Run /probe-mp4
  └── { url } → download → ffprobe → { duration_ms }                    ← NEW endpoint
      Auth: CRON_SECRET bearer. Used by the admin backfill route.

Vercel admin backfill_short_durations route
  └── per story:
      ├── if props.assembled_duration_ms present → use it
      ├── else: POST { url: video_url } to /probe-mp4 → get duration_ms
      │   → merge into props, write to stories.duration
      └── existing safe-overwrite gate (admin override preserved) is kept

Vercel readers (loadShortDurationsForStories, formatFullDurationForStory)
  └── prefer props.assembled_duration_ms when present
     ├── else fall back to body + intro + outro sum (legacy path)
     └── else fall back to body-only (legacy path)
```

## Alternatives considered

**B. Patch the formula.** Add `end_hold_ms` (1500 ms) into both
formulas and re-run the existing backfill. Rejected: still wrong for
any future splice change, still degrades to body-only when the
stamp is missing, doesn't reflect actual ffmpeg pad/round. Patches a
symptom, leaves the architecture lying about ground truth.

**C. Node-side MP4 parser in Vercel.** Use mp4box.js or a custom moov
parser to probe the MP4 without Cloud Run. Rejected: adds a JS
dependency, more code, less reliable than the ffprobe already running
in Cloud Run. Cloud Run already has ffmpeg available; using it is
strictly cheaper than parsing MP4 in Node.

**D. Cloud Run probes and writes back to DB directly.** Rejected: it
would couple Cloud Run to the app's DB schema. The current contract
is "Cloud Run returns URLs, Vercel owns persistence" — keep it.

## Security

- `/probe-mp4` endpoint requires `Authorization: Bearer
  ${CRON_SECRET}`. Same gate every other Cloud Run endpoint uses.
- The probe downloads MP4 from a URL the caller supplied. To prevent
  SSRF / probe-anything abuse, the endpoint accepts only URLs whose
  host is in an allow-list (the configured media bucket hosts:
  `storage.googleapis.com/${GCS_BUCKET}`, `MEDIA_PUBLIC_BASE` if set,
  Cloud Run's own bucket). Anything else returns 400. The allow-list
  is read from env so it stays in lockstep with the writer path.
- ffprobe is run on our own rendered MP4. No untrusted input reaches
  ffmpeg in the regular `/render` flow. The `/probe-mp4` endpoint
  enforces the allow-list before invoking ffprobe.
- Downloads are capped at 200 MB and 60 s. Anything larger is
  rejected — our shorts are ≤ 5 MB.

## Observability (rule 14)

Every step gets a namespaced log:
- `[cloud-run render duration_probe]` — `{ story_id, duration_ms,
  ms_to_probe }`
- `[cloud-run probe_mp4]` — `{ url_host, duration_ms, ms_to_probe,
  ms_to_download, byte_count }`
- `[short finish duration]` — `{ render_id, story_id,
  assembled_duration_ms }`
- `[homepage live catalog duration]` already exists — extend with
  `source: 'assembled' | 'sum' | 'body_only'` so we can grep what
  fraction of badges are still on the legacy math.
- `[backfill_short_durations row]` — `{ story_id, source,
  duration_ms, action: 'updated' | 'skipped' }`

## Settings (rule 15)

Nothing user-controllable. The duration badge contract is "actual MP4
length, formatted M:SS." No knob to expose.

## Testing (rule 18)

New / updated unit tests, all in vitest:

- `video/server/render.test.mjs` — extend the existing render tests
  with a duration_probe assertion (mock ffprobe to return a known
  number, assert the response carries it).
- `video/server/probe.test.mjs` — new file: URL allow-list passes /
  rejects, ffprobe wrapper returns ms, malformed responses surface
  as 5xx.
- `lorewire-app/src/lib/short-render-queue-apply.test.ts` — extend:
  when props carries `assembled_duration_ms`, `formatFullDurationForStory`
  returns it; absent value falls back to body+intro+outro sum.
- `lorewire-app/src/lib/homepage-data-duration.test.ts` — extend:
  reader prefers `assembled_duration_ms`; logs the source.
- `lorewire-app/src/app/api/admin/backfill_short_durations/route.test.ts`
  — extend: probe is invoked for stories without
  `assembled_duration_ms`; allow-list rejection surfaces as a per-row
  failure; existing safe-overwrite gate stays intact.
- `lorewire-app/src/lib/duration.test.ts` — new
  `assembledDurationMsFromPropsJson` helper.

Manual QA after merge:
- Open homepage on desktop + mobile. Pick 3 stories. Verify the
  badge value matches the watch-page player's `0:NN` to within ±1 s.
- Verify the WireCard pill still flips to the live `<video>` duration
  once playback starts (existing behavior, must not regress).

## Deploy (rule 19)

This change has a Cloud Run side AND a Vercel side. Production
currently runs off `feat/multi-platform-shorts-publisher` (per the
inverted state in AGENTS.md). Main is ~85 commits behind production.

Ordering:
1. **Cloud Run first.** Build + deploy the new `render.ts` + new
   `/probe-mp4` endpoint. Old Vercel ignores the new `duration_ms`
   response field and the new endpoint — fully backward compatible.
2. **Vercel second.** Open PR from `feat/actual-mp4-duration` →
   `feat/multi-platform-shorts-publisher` (NOT main; main is stale).
   Once preview is green, Yoav merges. Vercel auto-deploys from the
   production-source branch.
3. **Backfill third.** Once Vercel is live, hit POST
   `/api/admin/backfill_short_durations` to fix existing stories.
   Dry-run first (GET ?dry=1), then apply.

**What I will NOT touch:**
- `main` (it's stale; merging here would replay the 2026-06-23
  takedown described in AGENTS.md).
- Vercel UI "Promote to Production" / "Redeploy" / "Rebuild" buttons
  (per AGENTS.md, those bypass tracking).
- The `feat/social-poster-render` branch (Yoav's in-progress work,
  kept untouched on its own worktree).

Rollback path:
- Cloud Run: previous revision is one click away in the Cloud Run UI.
- Vercel: revert the merge PR; the prior production-source branch
  commit redeploys automatically.
- Backfill writes: the route only overwrites `stories.duration` when
  the existing value is NULL / "" or matches the body-only formula —
  same safe-overwrite gate that has been in place since PR #107. An
  unintended write touches at most the M:SS string column on a
  recoverable row.

## Out of scope (follow-ups)

- Removing the legacy body+intro+outro sum entirely. Once we're
  confident every row has `assembled_duration_ms` (post-backfill +
  some weeks of new renders), the sum path can be deleted. Until
  then, it stays as a safety net.
- Re-using the probe endpoint for the long-form video pipeline (same
  bug almost certainly exists there too, but the user's report is
  shorts-only; defer).
