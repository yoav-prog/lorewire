# Stories rail and IG-style Stories viewer (on top of Wires)

Date: 2026-06-25
Status: draft, awaiting approval

## Goal

Add an Instagram-Stories-shaped surface on top of the existing Wires
content. Two new pieces:

1. **Stories rail** — a horizontal strip of circular thumbnails near
   the top of the homepage. Unseen items wear an accent ring; seen
   items go quiet. Same on mobile and desktop, scaled by breakpoint.
2. **Stories viewer** — a full-screen (mobile) / centered-modal
   (desktop) overlay that opens when a rail thumbnail is tapped.
   Segmented progress bar across the top, auto-advance, tap-zones for
   prev/next, hold-to-pause, swipe-down to dismiss, swipe-up to open
   the full reader. Keyboard nav on desktop.

The viewer reuses the existing `WireStory` data and the same media
URLs the current `WireCard` plays — it is a second *presentation* of
the same content, not a new content type.

## Why this matters

The existing `WiresFeed` gives users a TikTok-shaped way to browse
shorts: open the Wires tab, scroll vertically. The homepage is the
discovery surface — most visitors land there first, see a curated
hero plus six category rails, and never reach the Wires tab.

A Stories rail at the top of the homepage gives visitors a low-cost,
familiar pattern (one-tap, swipe through, dismiss) that says "here is
what is new since you were last here" — surfacing freshness on the
landing page without forcing visitors to commit to the vertical
scroll. The unseen-ring signal is the load-bearing detail: it answers
"is there anything new for me?" at a glance.

## Requirements

1. Rail renders only on the homepage (`/`). Hidden on the Wires tab to
   avoid rail-vs-feed redundancy.
2. Rail contents: most recent N published wires the current visitor
   has not viewed, capped at 10, sorted newest-first. When the unseen
   set is empty the rail hides entirely.
3. Rail thumbnail: circular, 64px mobile / 72px desktop, accent ring
   (`--color-accent`, 2px) for unseen. One line of title underneath,
   ellipsized.
4. Tapping a thumbnail opens the viewer at that wire and pre-loads
   the rail's full list as the viewer's playlist.
5. Viewer auto-advance: video wires advance on `ended`; image / text-
   only wires advance after 6 s.
6. Viewer gestures (mobile):
   - Tap left third → previous wire
   - Tap right two-thirds → next wire (IG semantics)
   - Hold (pointer down ≥150ms) → pause; release → resume
   - Swipe down (>80px or fling) → dismiss
   - Swipe up (>80px or fling) → open the full reader at `/v/[slug]`
7. Viewer keyboard (desktop):
   - `←` / `→` → previous / next
   - `Space` → pause / resume
   - `Esc` → dismiss
   - `↑` / `Enter` → open the full reader
8. Audio: viewer reuses `useWirePrefs().muted` (one mute pref across
   the whole product — no new Stories-specific store).
9. Viewed-state write moment: mark viewed when a wire completes
   (video `ended` or image timer elapsed) OR on next/swipe-away with
   dwell ≥2 s. Quick tap-through under 2 s does not mark.
10. Deep link: `?wire=<id>` via `replaceState`. Closing removes it
    the same way. `?wire=` is distinct from `?story=` (claimed by
    the Comments deep-link in src/app/page.tsx + AppShell).
11. RTL: tap-zones mirror under `dir="rtl"`. Hebrew not shipped yet,
    but the gesture layer reads `document.dir` so the eventual RTL
    surface works without a refactor.
12. `prefers-reduced-motion: reduce` disables auto-advance entirely.
    Manual nav still works.
13. Empty / single-item playlists work without showing prev/next
    affordances that go nowhere.

## Out of scope (for this PR)

- Per-author "story buckets" (IG groups by user). Wires have no
  author attribution; ship a flat list.
- Promoted / sponsored slots.
- Server-side viewed-state sync for registered users. The
  localStorage Set is the source of truth; sync is a Phase 2.
- A Stories rail on category pages or article pages. Homepage only
  for v1.
- A dedicated Stories curation surface in HomepageCuration. The
  resolver piggybacks on `new_row` curation for v1.

## Chosen approach

### Source of the playlist

- New resolver `resolveStoriesPlaylist()` in a new module
  `src/components/stories/stories-playlist.ts` (kept next to the
  rail/viewer instead of inside `lib/homepage-rails.ts` so every
  Stories concept lives in one folder).
- Source: the merged catalog from `useHomepageCuration` (already
  fetched + SSR-seeded). Curated `new_row` ids pin at the front;
  fallback fills from the year-DESC published catalog up to the cap.
- The "unseen" filter runs CLIENT-side via `useViewedWires` so the
  SSR payload stays identical for every visitor (cache-friendly).

### Viewed-state store

- New `useViewedWires()` hook in
  `src/components/stories/use-viewed-wires.ts`. Mirrors the
  consent-gated, `useSyncExternalStore`-backed pattern from
  `engagement-store.ts`'s id-set stores but with **add-only `mark()`
  semantics** instead of `toggle()` — viewing isn't an undoable toggle.
- Storage key: `lw.viewed_wires.v1`.
- Same consent gate as the other stores; no persist without
  `lw_consent === "accepted"`.
- API: `viewed: string[]`, `isViewed(id)`, `markViewed(id)`,
  `clearViewed()` (the clear is for a future "reset" privacy control).
- Distinct from `useRecentlyViewed()` (LRU list of opens) and
  `useContinueReading()` (in-progress position).
- A test-only export `__viewedWiresStoreForTests` exposes the store
  primitive so unit tests don't need a React renderer (matches the
  workaround the rest of the codebase uses).

### Components

Five new files under `src/components/stories/`:

- `StoriesRail.tsx` — horizontal rail of circular thumbnails. Reads
  the playlist + `viewedIds` and renders nothing when the unseen set
  is empty.
- `StoriesViewer.tsx` — the overlay. Manages active index, paused,
  dwell, gesture state. Renders a stripped-down player (no scrubber,
  no like UI — those belong in the full WiresFeed, not the IG mode).
- `StoriesProgressBar.tsx` — top-of-viewer segmented bar. CSS animation
  + `animation-play-state: paused` for cheap pause behavior.
- `use-stories-gestures.ts` — React hook that attaches PointerEvents
  + the hold timer and dispatches actions from the pure reducer.
- `stories-gesture-machine.ts` — pure reducer (no DOM, no React).
  Tap/hold/drag → tap-prev/tap-next/pause/resume/dismiss/open-reader.
- `use-stories-url-state.ts` — `?wire=<id>` read/write via
  `history.replaceState` so the back stack stays clean.

### Hooks into the existing tree

- `AppShell.tsx` (MobileShell): compute playlist via
  `resolveStoriesPlaylist`, call `useStoriesUrlState`, pass playlist
  + viewedIds + `onOpenWire` to `Home`. Mount `<StoriesViewer />`
  at the shell return so it overlays every tab.
- `DesktopShell.tsx`: same, but inside `HomePage` for the rail and
  at the shell return for the viewer.
- No changes to `WireCard.tsx` or `WiresFeed.tsx`. The viewer is a
  separate component path.

### Gesture state machine

Pure reducer over four states (`idle`, `pressing`, `paused`,
`draggingV`) and four event kinds (`pointer-down`, `pointer-move`,
`pointer-up`, `hold-elapsed`). Resolves to one of: `tap-prev`,
`tap-next`, `pause`, `resume`, `dismiss`, `open-reader`, `snap-back`.
Configuration carries `width`, `height`, `isRtl`, and tunable
thresholds (`holdThresholdMs=150`, `moveStartThreshold=8`,
`dismissThreshold=80`, `dismissVelocityThreshold=0.6`). No external
deps.

### Deep-link wiring

- `?wire=<id>` written via `history.replaceState` — no back-stack
  pollution.
- Validated against the loaded playlist client-side; unknown id
  silently closes (defensive against stale share links).
- Share button inside the viewer copies the canonical `?wire=<id>`
  URL. The `/v/[slug]` reader path stays the authoritative permalink
  for SEO.

## Alternatives rejected

- **B (rail-only, deep-link into existing WiresFeed).** Cheapest, but
  breaks the brief — "swiping like in stories and every other story
  behavior" means horizontal tap-advance with segmented progress, not
  vertical scroll.
- **C (one component, two behavior modes).** Most cohesive long-term
  but puts churn in `WiresFeed`, the most load-bearing client
  component in the app.
- **D (use `embla-carousel` or `swiper`).** Drops a dep for one
  surface. Our gesture state machine is custom enough (hold-to-pause,
  dwell-tracking, dual-axis dismiss/open) that the generic carousel
  ends up wrapping our own logic anyway.

## Settings (rule 15 audit)

No dedicated user-settings page exists yet in this codebase. The
Stories feature reuses `useWirePrefs().muted` so the existing
mute pref applies across the whole product — no new Stories-only
toggle. Future controls that would land in a dedicated Settings
group: "Auto-advance" toggle, "Auto-advance duration", "Reset viewed
stories." Flagged for a follow-up plan when the settings layer
materializes.

## Security (rule 13)

- No new server endpoints. The rail + viewer consume the same
  `getHomepageCuration` + `getLiveCatalog` output the homepage rails
  already trust.
- `?wire=<id>` is validated against the loaded playlist client-side
  before render; unknown id silently closes. The id never reaches
  the server unparsed.
- `lw.viewed_wires.v1` stores ids only (no PII, no titles, no URLs).
  Consent-gated identically to the rest of `engagement-store.ts`.
- No `dangerouslySetInnerHTML` anywhere.
- Share copies the canonical `/v/[slug]` reader URL via the existing
  `storyShareUrl` helper, which already gates on the public slug.

## Observability (rule 14)

Namespaced log lines:

- `[stories rail mount]` — `{ total, unseen_count }` when the rail
  renders, or `[stories rail hide]` with `reason: 'all-seen'` when
  it doesn't.
- `[stories rail tap]` — `{ id, position, was_unseen }`.
- `[stories viewer active]` — `{ index, id, total }` on every
  active-wire change.
- `[stories viewer dismiss]` — `{ id, reason }`.
- `[stories viewed mark]` — `{ id, trigger, dwell_ms }`.
- `[stories gesture]` — `{ kind, state }` on every action.
- `[stories viewer error]` — `{ id, kind, src }` on media load
  failures (the viewer auto-advances on error rather than dead-
  stopping).
- `[stories url open]` / `[stories url close]` — URL state changes.

## Testing (rule 18)

Vitest unit tests, no React renderer needed (matches the codebase
pattern — `@testing-library/react` is not a dep):

- `use-viewed-wires.test.ts` — mark-once / clear / idempotency /
  storage round-trip / consent-gated in-memory-only behavior /
  subscriber notification counting.
- `stories-playlist.test.ts` — happy path with empty curation,
  filter-published, augment with new_row curation, dedup, cap,
  stale-id and unpublished-id handling, null curation degrade.
- `stories-gesture-machine.test.ts` — tap-zone resolution (LTR +
  RTL), hold-to-pause, swipe dismiss / open-reader, fling
  thresholds, snap-back, edge cases (mid-gesture re-press, lost
  pointer recovery).
- `use-stories-url-state.test.ts` — URL read/write round-trip,
  back-stack non-growth, close clears the param.

Component tests (rail, viewer) are out of scope at the unit level
(same reason the rest of the codebase manual-QAs components). Manual
QA in the deploy step covers the visual / DOM behavior.

## Deploy (rule 19)

**Read AGENTS.md's "main = production invariant" and the "Never
manually promote a non-production-source build" rules before
executing this section.** Lorewire is currently in the inverted
state — main is 10+ commits behind the production-source feature
branch. Confirm the current production-source branch from Vercel
Environments → Production before doing anything below.

Plan:

1. Branch `feat/stories-rail-and-viewer` off the current branch
   `feat/unified-story-editor-cut-4` (already done, on commit
   `cefadde`). This inherits all the recent feature work so the
   Stories code is written against the same `engagement-store.ts`
   that's actually live.
2. Build + commit per milestone (plan → tests → modules → mounts).
   No push until the build is complete and manually verified.
3. Run the divergence check from AGENTS.md before pushing:
   ```
   git fetch origin
   git log HEAD..origin/<production-source> --oneline
   ```
   If the first list is non-empty, bring the production-source
   branch in before pushing.
4. Push the branch, open a PR targeting the production-source
   branch (NOT main, while the inverted state persists).
5. Wait for the Vercel preview check to go green.
6. Manual QA pass on the preview URL.
7. Merge via `gh api graphql mergePullRequest` once approved.
   **Do not click "Promote to Production" / "Redeploy" / "Rebuild"
   on the Vercel preview** — auto-deploy fires off the production-
   source-branch merge; manual UI promotion has caused three
   takedowns.

Rollback: revert the merge commit and re-merge. The change is
additive (new files + small hooks in the homepage roots); a revert
should be clean.

## Open questions

- Rail size cap (10) — acceptable?
- Image-wire dwell (6s) — acceptable?
- Show-seen-in-rail default off → confirm OK.
- Settings group placement — defer until a user-settings page exists.

## Files this touches

New (under `src/components/stories/`):

- `use-viewed-wires.ts` + `.test.ts`
- `stories-playlist.ts` + `.test.ts`
- `stories-gesture-machine.ts` + `.test.ts`
- `use-stories-gestures.ts`
- `use-stories-url-state.ts` + `.test.ts`
- `StoriesProgressBar.tsx`
- `StoriesRail.tsx`
- `StoriesViewer.tsx`

Modified:

- `src/components/AppShell.tsx` — playlist + URL state hooks at
  MobileShell, rail in Home, viewer at shell return
- `src/components/DesktopShell.tsx` — same shape
