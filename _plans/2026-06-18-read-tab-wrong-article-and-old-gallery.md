# Read tab: wrong article + old gallery layout

**Date:** 2026-06-18
**Branch:** `feat/multi-platform-shorts-publisher`

## Goal

Restore the Read tab behaviour to what was working before the fork:

1. Stop the hardcoded "$800 Envelope" sample from rendering on every live story.
2. Restore the "one scene at a time with caption below" gallery layout in place of the multi-card scroller.

## Constraints

- Surgical: do not touch anything except what these two specific bugs require.
- Match the two known-good fixes that already exist in git history rather than re-design.
- Tests must stay green after the change.

## Source-of-truth commits

- `6ca82ac` — *Read tab: stop showing the envelope sample for every live story* (on `main`).
- `25c55bd` — *Read gallery: one scene at a time with the caption below* (on `origin/feat/reels-feed`, never merged).

Clean cherry-pick fails (4-way conflict) because this branch diverged from main before either commit. Apply the same logic by hand against the current files.

## Why the bugs surface here

Two pure-live stories shown in the screenshots — **The Steak Standoff** and **The Cold Shower Revenge** — are not in static `published.ts`. The `LiveCatalogStory` projection deliberately drops `body` / `images` / `audioUrl` / `alignment` to keep the rail payload small, so by the time `Read` receives the story `story.body` is `null` and the predicate `story.body ? <GenArticle/> : <hardcoded envelope>` falls through. The gallery layout is the old multi-card scroller because `25c55bd` was never merged.

## Files to edit

| File | Why |
| --- | --- |
| `lorewire-app/src/app/actions.ts` | Surface `body` on `LiveStoryMediaResult` and read it in `getLiveStoryMedia`. |
| `lorewire-app/src/lib/homepage-rails.ts` | Field-by-field merge in `mergeStaticAndLive` so a live row doesn't overwrite the static story's body / images / audio / alignment. |
| `lorewire-app/src/components/AppShell.tsx` | Thread `liveMedia` through `Read` → `GenArticle` → `_galleryFromStory`; use `liveMedia.body ?? story.body`; use `liveMedia.images` for inline scene images when the video is a short; update fallback predicate; replace the multi-card gallery with `GalleryCarousel`. |
| `lorewire-app/src/components/DesktopShell.tsx` | Same body-fallback fix in `Read` / `GenArticle`; replace `GalleryScroller` with `GalleryCarousel`. |

## Scope explicitly NOT covered

- `audio_url`, `alignment`, `source_url` on `LiveStoryMediaResult`. The original `6ca82ac` includes them because they were added earlier on main; this branch never picked them up and the two bugs don't depend on them. Keeping the surface tight.
- Any other shell behaviour, polls work, reels work, settings, etc.

## Observability

`getLiveStoryMedia` already logs `[lorewire media live]` with the result shape — body availability falls out of the existing `r.found` log. No new namespace needed.

## Testing

- `npm run lint --workspace lorewire-app`
- `npm test --workspace lorewire-app -- --run` (homepage-rails.test.ts in particular: confirms `mergeStaticAndLive` doesn't break expectations).

## Settings audit

No new user-facing controls. The change restores prior behaviour; nothing to expose.

## Security

No new attack surface. `body` is already publicly readable via `getPublishedStoryBySlug`; surfacing it on `getLiveStoryMedia` is equivalent.
