# Stories viewer: reader navigation (v2 item 1 of PR #79 follow-ups)

Date: 2026-06-25
Status: draft, awaiting approval
Predecessor: _plans/2026-06-25-stories-rail-and-viewer.md (shipped as PR #79)

## Goal

Restore the IG-style "open the underlying article" affordance that v1
deferred. PR #79 wired the gesture and the CTA placeholder but no-oped
both because the `Story` type doesn't carry a slug.

After this PR:

1. The viewer's "Read full →" CTA button navigates to `/v/[slug]`.
2. Swipe-up (gesture machine's `open-reader` action) navigates to
   `/v/[slug]`.
3. Keyboard `Enter` / `ArrowUp` navigates to `/v/[slug]`.
4. The Share button copies the canonical `/v/[slug]` URL (via the
   existing `storyShareUrl` helper) instead of the current
   `?wire=<id>` deep link.

## Why this matters

The Stories viewer is a discovery-and-skim surface. Without a path
out to the long-form reader, users who get hooked by a 9:16 wire have
no way to commit to reading the underlying piece. That breaks the
IG-Stories → IG-post mental model the v1 PR otherwise faithfully
implements.

The Share button copying the `?wire=` URL today also means recipients
get a less-canonical permalink than what `storyShareUrl` was built
to produce — every other share path in the app routes to `/v/[slug]`.

## Chosen approach

**Option (a) — slug on the `Story` type.** Extend
`lib/stories.ts`'s `Story` interface with `slug?: string`, and have
`liveRowToStory()` in `lib/homepage-rails.ts` copy `row.slug` into
the resulting Story. Every consumer that already holds a Story gets
the slug for free, no extra fetch.

Rejected (b): per-active-wire `getLiveStoryMedia(id)` fetch inside
the viewer. Works, but adds a per-wire round-trip when the data we
need is already projected through `LiveCatalogStory`.

### What changes

1. `lib/stories.ts` — add `slug?: string` to the `Story` interface,
   right next to `source_url?: string` (both are optional metadata).
2. `lib/homepage-rails.ts` — in `liveRowToStory()`, copy `row.slug`
   onto the returned Story when non-null. Also in
   `mergeLiveOverStatic()`, prefer the live slug over the static slug
   (static stories don't have one today, but matches the field-by-field
   merge pattern the helper already uses).
3. `components/stories/StoriesViewer.tsx`:
   - Re-import `storyShareUrl` from `@/lib/share`.
   - Keyboard handler: `Enter` / `ArrowUp` → `window.location.href = /v/[slug]` when slug is present.
   - Gesture `open-reader` action → same navigation.
   - Bottom chrome: add a "Read full →" button before the Share
     button, visible only when `active.slug` is set.
   - Share button: copy `storyShareUrl(active.slug, origin)` instead
     of `window.location.href`. Falls back to origin when slug is
     missing (matches `storyShareUrl`'s existing fallback).

### What does NOT change

- The `Story` type stays backward-compatible: `slug?` is optional, so
  static seed stories without a slug still satisfy the type.
- The viewer still works when the active wire has no slug: the CTA
  button hides, swipe-up no-ops (logged), keyboard nav no-ops.
- No new network calls. The slug is already in the SSR-seeded
  payload that drives the homepage rails.

## Security (rule 13)

- `slug` is a public, validated string the rest of the app already
  trusts for `/v/[slug]` routing. No new attack surface.
- The viewer's `window.location.href = /v/${active.slug}` is safe
  because the slug originates from `LiveCatalogStory.slug` (server-
  controlled), not from URL params or user input.
- Share URL stays canonical (`/v/[slug]`), not the internal id or a
  signed media URL — same constraint `storyShareUrl` enforces.

## Observability (rule 14)

- `[stories viewer open-reader]` — `{ id, slug, trigger: 'cta' | 'swipe-up' | 'keyboard' }` on each navigation.
- `[stories viewer share]` — already exists; now logs `slug` alongside `id` + `ok`.

## Testing (rule 18)

- `lib/homepage-rails.test.ts` — extend the (existing?) `liveRowToStory` /
  `mergeLiveOverStatic` coverage to assert that slug is propagated.
  If those helpers don't have direct test coverage today, add one
  small test for each (they're pure functions, trivial).
- Manual QA (on the Vercel preview):
  - Tap a wire → viewer opens, "Read full →" button visible
  - Tap "Read full" → navigates to `/v/[slug]`
  - Esc back, swipe up on the next wire → navigates to `/v/[slug]`
  - Esc back, Enter / ArrowUp on desktop → navigates
  - Click Share → clipboard contains `https://.../v/[slug]`, not `?wire=...`
  - Open a wire that has no slug (sample placeholder) → CTA hidden,
    Share button still works (falls back to origin)

## Deploy (rule 19)

1. Branch `feat/stories-reader-navigation` off
   `origin/feat/multi-platform-shorts-publisher` (already done).
2. Commit, push, open PR targeting `feat/multi-platform-shorts-publisher`.
3. Vercel preview check, then merge — auto-deploys to production.
4. **Do not click "Promote to Production" / "Redeploy" / "Rebuild"**
   in Vercel UI.

## Out of scope (deferred to later v2 items)

- Items 2-10 from the PR #79 v2 punch list (settings, server sync,
  drag-after-hold, pen, author groups, promoted slots, rail on
  other pages, dedicated curation surface, manual-QA pass).
