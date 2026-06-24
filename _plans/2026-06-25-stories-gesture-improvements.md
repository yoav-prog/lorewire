# Stories: gesture improvements + ring-fade + desktop removal

Date: 2026-06-25
Status: in flight
Predecessors:
  - PR #79 — _plans/2026-06-25-stories-rail-and-viewer.md (v1)
  - PR #80 — _plans/2026-06-25-stories-reader-navigation.md (slug + Read full)
  - PR #82 — _plans/2026-06-25-stories-desktop-layout.md (desktop layout fix)

## Bundled scope

Four small, related Stories tweaks shipped together because each is
self-contained and reviewing them as one PR is faster than four:

1. **Drag-after-hold gesture** (v2 item 4) — vertical move past
   `moveStartThreshold` while paused now promotes to `draggingV` +
   emits a synthetic `resume`. Matches IG behavior.
2. **Pen / stylus support** (v2 item 5) — drop the `pointerType: "pen"`
   filter in `use-stories-gestures.ts`.
3. **Ring-fade for viewed stories** — viewed wires stay in the rail
   with a dimmed ring (`--color-line` 1.5px + 0.7 opacity) and a
   `transition: 320ms ease` so the moment of mark-viewed fades the
   highlight rather than snapping it. Matches IG ("you've seen this"
   cue). v1 used to hide viewed stories entirely, which lost the
   re-watch affordance.
4. **Remove StoriesRail from desktop** — final product call after
   PR #82's layout iteration still didn't read well against the hero
   composition. Desktop discovery happens through the existing rails
   (Continue Watching, Top 10, category rails). Mobile keeps the
   rail; AppShell.tsx is unchanged.

## Why

- (1) Drag-after-hold: IG promotes; users who've used IG will expect
  it. Skipping it forces an extra "release then swipe" step.
- (2) Pen: Surface / iPad-with-pen users couldn't drive the viewer
  before. Pen events flow through the same PointerEvent shape; the
  filter was conservative for no real reason.
- (3) Ring-fade: hiding viewed stories was the wrong call. It
  punishes users who actually consumed the content and removes the
  re-watch affordance. IG dims; we should too.
- (4) Desktop removal: the rail is an IG-mobile pattern. On
  desktop the design language is Netflix-rail/full-bleed-hero, and
  the circular thumbnails don't sit naturally in either composition.
  Better to remove than to keep iterating.

## Changes

### Gesture machine (item 4)

`stories-gesture-machine.ts`:

- Extend `paused` state shape with `startX`, `startY` (today carries
  only `startT`). The reducer needs them to compute `dy` during
  paused-state `pointer-move`.
- `hold-elapsed` (which transitions `pressing` → `paused`) forwards
  `startX/Y` along.
- `pointer-move` while `paused`: when `|dy| >= moveStartThreshold`,
  promote to `draggingV` AND emit `{ kind: "resume" }`.
- Update the existing test that pinned the v1 limitation; add boundary
  + full-sequence drag-after-hold coverage.

### Pen support (item 5)

`use-stories-gestures.ts`:

- Replace the `mouse | touch` allowlist in `onPointerDown` with
  `mouse | touch | pen`.

### Ring fade

`StoriesRail.tsx`:

- Don't filter the playlist to unseen-only; render every story.
- `RailThumb` accepts `viewed: boolean`. Ring style swaps based on
  it:
  - unseen → 2px `--color-accent` background, full thumb opacity
  - viewed → 1.5px `--color-line` background, 0.7 thumb opacity,
    muted title color
- Both swaps use `transition: 320ms ease` so the mark-viewed moment
  fades.
- Hide rail entirely only when the PLAYLIST is empty (no published
  stories at all), not when all-viewed.
- `[stories rail mount]` log gains `viewed_count` alongside
  `unseen_count`.
- `[stories rail tap]` `was_unseen` now reflects the actual state.

### Desktop removal

`DesktopShell.tsx`:

- Drop the StoriesRail import + the playlist resolver + the URL
  state + viewedWires hooks + the StoriesViewer mount.
- Drop the `storiesPlaylist`/`viewedWireIds`/`onOpenWire` props from
  the HomePage signature + call-site.
- Drop the unused `useMemo` from the React imports (was only used
  for the stories playlist memo).
- Replace the imports block with a comment explaining the decision.

`StoriesRail.tsx`:

- Drop the `title?: string` prop (it was only used by desktop).
- Simplify the rail to a single mobile presentation.

### What does NOT change

- `AppShell.tsx` — mobile mount is correct, untouched.
- `StoriesViewer.tsx` — still mounted by mobile, no change.
- The `?wire=<id>` deep link — still works on mobile via the rail
  + URL state hook in AppShell. (On desktop, a `?wire=<id>` URL is
  now a no-op because nothing mounts the viewer — acceptable for
  v1 of "desktop has no stories"; if desktop deep links matter
  later, mount the viewer in DesktopShell without the rail.)

## Tests (rule 18)

- `stories-gesture-machine.test.ts` — three new / replaced tests for
  drag-after-hold (promotes + emits resume; sub-threshold stays
  paused; full-sequence drag-after-hold → dismiss).
- `stories-playlist.test.ts` — unchanged; the resolver doesn't know
  about viewed state.
- `use-viewed-wires.test.ts` — unchanged.
- StoriesRail visual tests don't exist (no @testing-library set up
  in this codebase); manual QA covers the ring-fade + desktop
  removal.

## Security / observability

No new attack surface, no new data flow. `[stories gesture]` already
emits for every action — `resume` followed by `dismiss` or
`open-reader` will both show. `[stories rail mount]` log now carries
`viewed_count`.

## Deploy (rule 19)

- Branch: `feat/stories-gesture-improvements-v2` off
  `origin/feat/multi-platform-shorts-publisher` (worktree at
  `C:/Projects/lorewire-stories-gestures`).
- PR target: `feat/multi-platform-shorts-publisher` (production
  source, inverted-state rules).
- **Do not click "Promote to Production" / "Redeploy" / "Rebuild"**.

## Out of scope (deferred v2 items from PR #79 punch list)

- Item 2 (settings) — blocked on a user settings page existing.
- Item 3 (server-side viewed-state sync) — blocked on auth flow.
- Item 6 (per-author story groups) — blocked on author attribution.
- Item 7 (promoted slots) — blocked on monetization scaffolding.
- Item 8 (rail on category / article pages) — separate PR.
- Item 9 (dedicated stories curation surface) — needs editorial
  signoff first.
