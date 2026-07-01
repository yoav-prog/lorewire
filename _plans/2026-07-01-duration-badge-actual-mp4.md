# Duration badge shows body-only length instead of the actual MP4

Date: 2026-07-01
Branch: fix/hook-tail-hold-dynamic
Status: approved, implementing

## The bug

On the story detail modal (desktop) and title sheet (mobile), the small
duration chip next to the year shows the body-only "scenes" length (e.g.
0:36) while the video player below it plays the real assembled MP4 (0:48,
with intro + outro + tail-hold). The badge and the player disagree. The
user wants the ACTUAL playback time shown everywhere.

## Root cause

Every duration badge in the app reads one field: `story.dur`, which comes
straight from `stories.duration` via `loadLiveCatalog` ->
`liveRowToStory` (`dur: row.duration ?? ""`). Confirmed at all display
sites: DesktopShell DetailModal chip, AppShell hero/detail/title/rail
chips. The only surface that does NOT trust the stored value is the mobile
WireCard, which already prefers the live `<video>` measured duration.

The stored `stories.duration` holds a stale body-only value because of two
gaps that let a wrong value survive:

1. The reader (`loadLiveCatalog`) only backfills durations that are NULL.
   Once any value is written, no read ever corrects it
   (`rows.filter((r) => !r.duration)`).
2. The write path (`applyShortToStory`) only stores the true assembled
   length when that render captured `props.assembled_duration_ms`. A
   render that predates the ffprobe, a probe failure, or an older Cloud
   Run revision that omits `duration_ms` all fall back to body-only.

So a story rendered before the assembled probe (or via a path that missed
it) got "0:36" written to `stories.duration`, and nothing ever refreshes
it. The tail-hold work makes videos longer, which widens the gap and makes
the stale rows obvious again.

The existing admin backfill route already solved the "stale vs admin
override" problem with a safe-overwrite gate
(`api/admin/backfill_short_durations/route.ts`): it overwrites when the
stored value is empty OR equals the body-only formula (clearly
auto-written), and preserves it only when it is a genuine admin override
(non-empty and different from body-only). The reader never learned that
gate. That is the fix.

## Chosen approach — two layers

### Layer 1: display safety net on the two player surfaces

The badge next to a live `<video>` must equal what plays. In both
DetailModal (DesktopShell) and TitleSheet (AppShell):

- Hold a `measuredDurationMs` state on the sheet, reset to null on story
  change (piggyback the existing render-time story-change reset block).
- Pass an `onDurationMeasured(ms)` callback into the local WatchDoodle;
  its `<video onLoadedMetadata>` reports `duration * 1000` when finite.
- The meta chip prefers `formatDurationMs(measuredDurationMs)` over
  `story.dur`, falling back to `story.dur` before metadata loads or on a
  non-Watch first tab.

This mirrors the WireCard pattern (prefer live `<video>` metadata over the
stored value) and guarantees the number next to a playing video can never
drift again.

### Layer 2: reader self-heal (port the backfill's safe-overwrite gate)

In `loadLiveCatalog` / `loadShortDurationsForStories`:

- Compute the short duration for ALL stories that have a done render (not
  just NULL-duration ones). Return `{ full, bodyOnly }` per story.
- Apply the safe-overwrite gate on the stored value:
  - empty (`null` or `""`) -> use `full`
  - stored === bodyOnly (auto-written stale) -> use `full`
  - otherwise (admin override) -> keep stored

This heals the stale body-only "0:36" to the assembled "0:48" on every
read, for every badge surface including rails and posters that have no
player to measure. Existing admin-override tests still pass because those
seed values differ from body-only.

## Alternatives rejected

- Display safety net only. Fixes the modal/sheet the user is looking at,
  but rail and poster thumbnails (no player) keep the stale value.
- Data repair only (run the backfill route once). Fixes existing rows but
  a future probe failure or an un-backfilled row silently reintroduces the
  mismatch. Not self-healing.
- Reader always recomputes and ignores `stories.duration` entirely. Would
  clobber genuine admin overrides; contradicts the tested contract.

## Known limitation (accepted, matches the backfill route)

A stored value that equals an OLD sum (not body-only and not an admin
value) is treated as an admin override and left alone by the gate. Only
empty-or-body-only self-heals. This is the same tradeoff the backfill route
already makes; the 12s body-vs-assembled gap (the actual bug) heals, and
Layer 1 covers the player surfaces regardless.

## Security / safety

No new inputs, endpoints, secrets, or PII. Reads existing columns; the
gate only ever replaces an auto-written value with a computed M:SS string.
`formatDurationMs` is a pure, import-safe function (no server-only deps),
so importing it into the client shells adds no server code to the bundle.

## QA checklist

- Existing `homepage-data-duration.test.ts` stays green (admin overrides
  preserved, NULL durations backfilled, non-done ignored, latest-done
  wins, malformed props skipped).
- New tests: stale body-only stored duration self-heals to assembled and
  to sum; admin override that differs from body-only is kept.
- Manual: modal + mobile sheet badge matches the player's total time once
  metadata loads; rail/poster badge reflects the healed value.
