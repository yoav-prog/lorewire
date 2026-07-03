# Slide between stories of the same row

Date: 2026-07-04
Status: approved (Option A picked by Yoav)
Branch: feat/story-slide-nav

## Goal

From the story detail surface (mobile TitleSheet, desktop DetailModal), the user
can move to the previous/next story of the list they opened it from, with
wrap-around (story 1 slides back to story 10). Works on desktop (edge chevrons +
arrow keys) and mobile (swipe + chevrons). Applies to:

- Homepage rows (Top 10 Today, You Didn't Vote Yet, category rails, New on LoreWire)
- Browse (desktop) / Search-as-browser (mobile) — respects the active ?cat filter:
  sliding covers only the filtered result set
- Today's Verdicts (desktop view) / New & Hot (mobile "Today's" tab)
- Saved (desktop grid) / My List (mobile)
- More Like This inside the detail surface (opening from it re-anchors the
  slide context to that rail)

## Why Option A (context passed with the open call)

Every one of these surfaces already computes its ordered list client-side and
opens stories via `onOpen(id)` into shell-level modal state — no page
navigation anywhere. Passing the exact visible list with the call guarantees
the slide order always matches what the user was looking at (filters, curation,
insertion order), with one mechanism shared by all surfaces.

Rejected:
- Option B (pass a key, re-derive the list in the modal): couples the modal to
  every surface's derivation logic (curation rails, pill filters, personalized
  continue rail, Saved storage) and risks divergence from what the user saw.
- Option C (horizontal snap carousel with pre-mounted neighbors): TitleSheet /
  DetailModal are heavy (video player, comments, live media fetch); mounting
  neighbors multiplies cost and creates playback conflicts. Big refactor for a
  marginal feel upgrade over a slide transition.

## Design

### Shared helper — `src/lib/slide-context.ts` (new, client-safe, no server-only)

```ts
export type SlideContext = { ids: string[]; label: string };
slidePosition(ctx, currentId) -> { index, total } | null   // null when not slidable
slideTarget(ctx, currentId, dir: -1 | 1) -> string | null   // wrap-around modulo
resolveSwipeDirection(dx, dy) -> -1 | 1 | null              // threshold + horiz-dominance
```

Slidable = ctx present, >= 2 ids, currentId included. Not slidable -> controls
hidden entirely (deep links via ?story= have no context, correct for shared links).

### Plumbing

- `OpenFn` gains an optional third arg: `(id, tab?, slide?: SlideContext)`.
- Shell `active` state gains `slide?: SlideContext`; `open()` stores it.
- Each surface passes its visible ordered ids + on-screen label:
  - Mobile Home rails, mobile Search (filtered res), NewScreen, MyList,
    TitleSheet More Like This.
  - Desktop Home rails (incl. Top10Row), GridPage (one wiring covers Browse /
    Today's Verdicts / Saved via its ids + title), SearchPage, DetailModal
    More Like This.
- Sliding calls `onOpen(target, currentTab, sameContext)` — tab is preserved
  while flipping (reading -> keep reading).
- Out of scope: hero/Billboard (already a carousel, not a row), Wires feed
  (vertical feed, different modality), PollRailCard (doesn't use onOpen; its
  cards are a vote flow, not a story open).

### UI

- Desktop DetailModal: circular chevrons on the scrim at the viewport edges
  (vertically centered, stopPropagation so scrim-close doesn't fire), reusing
  the existing ChevL/ChevR icons; ArrowLeft/ArrowRight keys (guarded against
  INPUT/TEXTAREA/VIDEO/contentEditable targets); position chip
  "3 / 10 · TOP 10 TODAY" bottom-center of the hero header (mono, muted).
- Mobile TitleSheet: swipe left/right on the sheet (touchstart/touchend pair,
  Billboard's pattern: horizontal-dominant + threshold; ignores gestures that
  start inside a horizontal scroller, VIDEO, or input); small chevrons at the
  header's left/right edges (same chip style as the close button) for
  discoverability; same position chip at the header's bottom edge.
- Transition: inner content wrapper keyed by story.id gets a ~200ms
  translate+fade class (direction-aware), keyframes added to globals.css next
  to the existing fadeIn/sheet-in family. Honors prefers-reduced-motion.
- Wrap-around always on, per spec.

## Security

No new trust boundaries. Ids come from the in-memory merged catalog, never from
user input; the deep-link path (?story=) deliberately carries no slide context.
resolveStory already null-guards unknown ids; slidePosition returns null on a
missing/stale id (e.g. unsaving the open story from Saved context) and the
controls hide. Nothing new is persisted or logged beyond story ids.

## Observability

`console.info("[slide nav]", { shell, label, from, to, dir, index, total })`
on every slide; `console.info("[slide nav hidden]", { reason, id, label })`
when a context is present but not slidable. Matches rule-14 namespacing.

## Settings

Audited: no new setting. Sliding is a navigation affordance with no default to
flip; controls hide themselves when there is nothing to slide to. Intentionally
not exposed.

## Testing

- New `src/lib/slide-context.test.ts` (vitest, matches existing *.test.ts
  conventions): wrap-around both ends, middle moves, single-item list, id not
  in list, empty list, swipe direction thresholds (horizontal-dominance,
  vertical-dominant rejection).
- Full `npm test` suite must stay green; `npm run lint` and `npm run build`
  before calling it done.
- Gesture/DOM wiring itself is exercised manually (golden path on both shells);
  the decision logic it delegates to is what's unit-tested.

## Deploy

Standard flow: branch `feat/story-slide-nav` off up-to-date `main`, PR into
`main`, Vercel preview from the branch, merge triggers production deploy of
main. No env, schema, or config changes. Rollback = revert the merge commit.
