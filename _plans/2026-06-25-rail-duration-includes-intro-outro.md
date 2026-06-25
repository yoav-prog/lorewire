# Rail thumbnail duration must include intro + outro segments

## Symptom

Home page rail card shows `0:42`. Open the same story, native `<video>`
reports `0:49`. The card duration is the short's body length (captions /
voiceover), the player length is the body **plus** the intro/outro
segments Cloud Run splices on. Users see a length that doesn't match
the file they're about to play.

## Root cause

- `stories.duration` (M:SS) is the source of truth for the rail badge.
- The reader path in `loadShortDurationsForStories`
  ([src/lib/homepage-data.ts:103-122](lorewire-app/src/lib/homepage-data.ts#L103-L122))
  backfills it from `short_renders.props.duration_ms` when the column
  is NULL.
- The writer path in `applyShortToStory`
  ([src/lib/short-render-queue.ts:312-331](lorewire-app/src/lib/short-render-queue.ts#L312-L331))
  writes it from the same `props.duration_ms`.
- `props.duration_ms` is the **body** of the short. The intro/outro
  durations live on `video_segments.duration_ms` and the segments are
  spliced by Cloud Run.
- The route stamps `_last_rendered_segments` onto
  `stories.short_config` after a successful render
  ([src/app/api/render_short/route.ts:586-604](lorewire-app/src/app/api/render_short/route.ts#L586-L604)),
  so the splice contract is already persisted; nothing else reads it.

## Goal

Wherever we compute or display "the duration of the short," include the
intro + outro segments. Both reader and writer paths.

## Constraints (rules)

- **Verify, don't guess (rule 1):** read the actual stored data
  (`video_segments`, `short_config._last_rendered_segments`) rather
  than estimating segment length.
- **Match the file's structure (rule 2):** the new logic lives next to
  the existing duration helpers in `lib/duration.ts` and in
  `lib/homepage-data.ts`; same imports order, same comment cadence.
- **Admin override still wins (user pick):** the existing precedence
  in `loadLiveCatalog` (admin-set `stories.duration` beats any backfill)
  is preserved. Test at
  [src/lib/homepage-data-duration.test.ts:125-140](lorewire-app/src/lib/homepage-data-duration.test.ts#L125-L140)
  stays green.
- **Observability (rule 14):** the new join logs `body_ms`,
  `intro_ms`, `outro_ms`, `total_ms` per story so a bad row in
  production is one console paste away from a diagnosis.
- **Testing (rule 18):** unit tests cover sum-with-segments, missing
  segments (body-only fallback), missing stamp (body-only fallback),
  admin override still wins, and the writer path writes the full
  duration.
- **Security (rule 13):** no new attack surface; read-only DB reads
  against existing tables, no new external calls, no user input.
- **Deploy (rule 19):** PR off the current branch into main, no
  promote/redeploy clicks on previews. Production source branch was
  `feat/multi-platform-shorts-publisher` last we touched it; verify
  before opening any PR.

## Approach (user-picked: sum at read time + persist in writer)

1. Add `parseLastRenderedSegments(shortConfigJson)` to `lib/duration.ts`.
   Returns `{ intro_segment_id: string|null, outro_segment_id: string|null }`
   or `null` if no stamp / malformed JSON.

2. Add `fullDurationMsFromParts(bodyMs, introMs, outroMs)` to
   `lib/duration.ts`. Pure sum, clamps negative/non-finite to 0.

3. Extend `loadShortDurationsForStories` to:
   - Pull `id, short_config` for the same story ids.
   - Pull `id, duration_ms` for every intro/outro segment id referenced.
   - Sum body + intro + outro per story, format with `formatDurationMs`.
   - All three reads run in parallel.

4. Update `applyShortToStory` to read `stories.short_config` for the
   same stamp, look up the segment durations, sum, and write the
   full duration. Body-only fallback when no stamp / missing segments
   so legacy paths still produce *some* duration.

5. Reader-side fallback: when a story has body but missing/invalid
   stamp or missing segment rows, keep today's body-only behavior so
   we never make the badge worse than it currently is.

## Touched files

- `src/lib/duration.ts` — two new pure helpers.
- `src/lib/homepage-data.ts` — extended `loadShortDurationsForStories`.
- `src/lib/short-render-queue.ts` — extended `applyShortToStory`.
- `src/lib/homepage-data-duration.test.ts` — new cases for segments.
- `src/lib/short-render-queue-apply.test.ts` — new cases for segments.
- (Optional) new `src/lib/duration.test.ts` for the pure helpers.

## NOT touched

- `_last_rendered_segments` stamp shape — already the contract.
- Cloud Run / Python pipeline — pure TS-side derivation.
- `ContentList.tsx` / admin `/content` — no duration column today;
  adding one is a separate UI feature, out of scope.
- Story OverviewTab manual duration input — already reads
  `stories.duration`, so it picks up the fix for free.
- Short editor preview composition — that's the body-only seek view
  by design (`shortConfigToVideoConfig` already documents this).

## Rollback

Single-commit change in `loadShortDurationsForStories` and
`applyShortToStory`. Revert reverts both. Stories with already-written
`stories.duration` keep that value either way; the worst case if we
revert is the rail goes back to showing body-only.

## Test plan

- `npm test` — full vitest suite green.
- Pull the production DB for a story whose short has a known intro
  (e.g. the 7s segment we see in the screenshot), verify the new
  computed duration equals what the `<video>` reports.
- Visual: refresh the home page, confirm the rail card and the player
  match.
