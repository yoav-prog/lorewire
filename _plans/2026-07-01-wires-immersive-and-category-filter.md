# Wires: immersive fullscreen + category filter

Date: 2026-07-01
Branch: `feat/wires-immersive-and-categories`, stacked on `feat/wires-cleaner-ui`
(PR #192, the declutter) since both build on the reworked `WireCard`.

## Goals (user asks)

1. **TikTok-style fullscreen.** Today the fullscreen button fullscreens only the
   video stage, so there's no feed behind it and swiping does nothing. The user
   wants a dedicated **video-only immersive mode**: the video fills the screen,
   controls overlay on top, and swiping up/down pages between wires.
2. **Category filter** on the Wires page (mobile + desktop): a clean, intuitive
   way to see only wires of chosen categories. Multi-select.

## Data model finding (category filter)

Wires are categorized two ways mid-migration:
- Legacy `stories.category` — the old six labels (Drama/Entitled/…); what the
  card chip shows today. Being retired.
- **Granular taxonomy (18)** in `story_tags(story_id, category_slug, is_primary)`
  — the current source of truth, populated by #188/#189, already used by the
  `/c/<slug>` pages via `getStoriesForCategory` (a `JOIN story_tags` filter).

**Decision:** filter server-side on `story_tags.category_slug` (the granular
taxonomy), not the legacy label. Use the client-safe static `GRANULAR_CATEGORIES`
(lib/categories/granular.ts) for the filter chips and the card's category label
so both surfaces speak the same taxonomy. (Admin-added categories beyond the seed
are a later follow-up — the read path stays correct because the SQL filters by
whatever slug is passed.)

## Feature 2 — category filter (build first; contained + testable)

- **Server** (`listPublishedShorts`): add `categorySlugs?: string[]`. When set,
  add `AND EXISTS (SELECT 1 FROM story_tags t WHERE t.story_id = stories.id AND
  t.category_slug IN (…))` — EXISTS (not JOIN) so a multi-tagged wire isn't
  duplicated and the LIMIT counts correctly. Also attach each wire's primary
  `category_slug` (one batch query, mirrors `attachLikeState`) → new
  `WireStory.category_slug`.
- **Store** `lib/wire-category-filter.ts`: in-memory module singleton holding the
  selected slug Set (survives tab switches within the SPA, resets on reload —
  a browsing filter, not a persisted preference). `useWireCategoryFilter()` +
  toggle/clear.
- **UI** `components/wires/WireCategoryFilter.tsx` (shared mobile + desktop): a
  funnel button (with an active-count badge) next to the Unvoted/All pill; opens
  a sheet (mobile) / popover (desktop) of multi-select category chips from
  `GRANULAR_CATEGORIES`, with Clear. Closes on backdrop/Escape.
- **Wiring**: `useWiresData(pageSize, onlyUnvoted, categorySlugs)` — refetch when
  the slug list changes (same reset pattern as `onlyUnvoted`). `WiresFeed` +
  `WiresDesktop` read the store, pass the button + slugs. Card shows the granular
  label (lookup by `category_slug`), falling back to the legacy `category`.
- Empty state when a filter yields nothing: "No wires in these categories" +
  Clear.

## Feature 1 — immersive fullscreen (video-only + swipe)

- **`WireCard` `immersive` prop.** When true the card is video-only (no bottom
  control bar); overlays on the video: mute + ⋯ (top-right, existing), a Close/
  exit button (top-left), a TikTok-style vertical action rail (like + count,
  save, share) bottom-right, the title bottom-left, and poll access via the
  existing `WirePollPill` → opens the `WirePollPanel` in a bottom sheet over the
  video. Keeps `object-contain` (burned-in captions must stay visible).
- **Feed orchestration.** The fullscreen button now enters immersive mode:
  `WiresFeed`/`WiresDesktop` set `immersive` state, render immersive cards, and
  request real fullscreen on the scroll container so native snap-scroll pages
  wires (mobile swipe; desktop keeps wheel/arrow). Exit on Close button, Escape,
  or `fullscreenchange` → clears immersive. Drop the per-card `insetBottom` in
  immersive (no nav to clear).
- Reuses all existing playback/gesture/paging logic in `WireCard` + the feed —
  only the card's chrome layout changes with `immersive`.

## Security / safety
- Category filter reuses the same published-visibility gate; EXISTS subquery is
  parameterized (no injection). No new PII. Immersive mode is pure client UI over
  the existing Fullscreen API (user-gesture gated).

## QA
- Unit: category-filter store; `useWirePrefs`/data refetch on slug change;
  `WireCategoryFilter` render + multi-select; `WireCard` immersive layout
  (video-only, no bottom bar, action rail present, exit button).
- tsc + eslint + full `vitest run` (expect the same 7 pre-existing failures).
- Visual: can't run `next dev` locally (missing @vercel/@sentry in the junctioned
  install) — verify on the PR's Vercel preview. Flag this to the user.

## Rejected
- Fullscreen the whole feed (bar visible) — simpler but not the video-only TikTok
  feel the user picked.
- Legacy-label category filter — breaks as the six are retired; granular is the
  live taxonomy.
- Persisted category selection — a stuck filter is confusing; session-scoped.
