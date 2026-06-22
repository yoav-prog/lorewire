# Working share + personal story ratings

Date: 2026-06-22
Branch: feat/gdpr-compliance (share shipped here; ratings is a follow-up)
Status: Phase A (Share) DONE. Phase B (Rate) planned, not started.

## Goal

The homepage detail modal (the PLAY / My List / Rate / Share action bar in both
the mobile `AppShell` and desktop `DesktopShell`) had a working My List button
but dead Rate and Share buttons. Make them real, and let a visitor share a
direct link to a specific story. Show a rating on the homepage thumbnails.

## Decisions locked with the user (2026-06-22)

- **Rating model: personal star + keep a card score.** The star sets the
  visitor's own 1-5 rating, surfaced as "Your rating". Thumbnails keep showing a
  per-card score. A community average can replace that card score later, once
  there is real traffic. We do NOT show a fabricated community average on a
  zero-traffic product.
- **Who can rate: anonymous, like the polls.** One rating per browser via a
  cookie token (the existing poll anti-double-vote primitive). A magic-link
  sign-in can upgrade / merge it later.
- **Sequence: ship Share now, plan Rate next.**

## Brutally honest context that shaped this

- The Rate star had **no backend at all** — no table, no write path. Polls
  (`poll_votes` / `poll_aggregates`) are a separate two-option feature; the
  schema's "rating for review" is an editorial payload field, not a user rating.
- The "% Match" already on the cards (`stories.ts` `match: 97`, etc.) is
  **fabricated sample data**, which sits awkwardly next to the product's stated
  "no fabricated counts" ethos (`engagement-store.ts`). A community star average
  added now would show "no ratings yet" on nearly every card — the cold-start
  trap. Personal-only ratings avoid it.

## Phase A — Share (DONE)

Shipped on this branch:

- `src/lib/share.ts` (new) — one share path for the whole app:
  - `storyShareUrl(slug, origin)` builds the public canonical `/v/[slug]`, or
    falls back to the bare origin when there is no published slug (never a 404,
    never an internal id or signed media URL).
  - `shareOrCopy({ url, title })` — native share sheet first, clipboard copy as
    the fallback, and it never copies-on-dismiss (returns `"unavailable"` when
    the native sheet is dismissed). Returns the outcome so callers flip a
    transient "Copied" / check confirmation only when the clipboard path ran.
  - `src/lib/share.test.ts` — 6 tests, all green.
- `src/app/actions.ts` — `getLiveStoryMedia` now returns `slug`. Its published
  gate is identical to `getPublishedStoryBySlug`, so `found === true` ⟺
  `/v/[slug]` resolves; the share link is therefore always real.
- `DesktopShell.tsx` / `AppShell.tsx` detail modals — Share button wired to the
  helper with a check / "Copied" confirmation. `NO_LIVE_MEDIA` seeds updated.
- `ReelCard.tsx` — refactored onto the shared helper (behavior preserved), so
  there is now a single share implementation instead of three copies.

QA: `vitest` lib suite 924/924 green; `tsc` and `eslint` introduce no new
errors on the touched files (pre-existing repo lint/type debt untouched).

## Phase B — Personal star rating (NEXT, not started)

### Chosen approach: collect server-side now, show personal-only

Store every rating server-side via the anonymous cookie token (reuse
`poll-cookie`), but only ever DISPLAY the visitor's own rating until a community
average is deliberately switched on. This is the codebase's "pre-instrument now"
pattern: it builds the real dataset so the future community average does not
start from zero, while staying honest today.

- **B1 Schema** — new `story_ratings` table mirroring `poll_votes`:
  `id, story_id, cookie_token, user_id (nullable), stars (1-5), created_at,
  updated_at`. Unique index on `(story_id, cookie_token)`; partial unique on
  `(story_id, user_id) WHERE user_id IS NOT NULL` — same two-index anti-dup
  pattern the polls already use. Re-rating UPSERTs the existing row.
- **B2 Server actions** — `rateStory(storyId, stars)` (validate `stars ∈ 1..5`,
  validate the story is published, issue/read the cookie token, upsert) and
  `getMyRating(storyId)` / a batched `getMyRatings(ids)` for the homepage.
- **B3 UI** — the Rate star opens an inline 1-5 star row in both modals;
  optimistic update; clear "Your rating ★4" state; obvious re-rate / clear.
- **B4 Thumbnails** — thread the visitor's ratings into the homepage shells the
  same way `useSavedStories` / `useLikedReels` are, and render a small
  "★N" badge on cards the visitor has rated (mobile + desktop). The existing
  card score stays as the always-present number until Phase C.
- **B5** — tests + QA + the security items below.

### Alternatives rejected

- **localStorage-only personal rating** (simplest, mirrors like/save exactly,
  zero backend). Rejected as the primary because it collects no data for the
  future community average and never syncs across devices — we would be
  throwing away every rating. Kept as the fallback if we decide ratings should
  never aggregate.
- **Community star average now (IMDb-style).** Rejected: cold-start trap on a
  zero-traffic product + clashes with the no-fabricated-counts ethos. This is
  Phase C, switched on once `story_ratings` holds real volume.
- **Thumbs / % liked.** Rejected: the user chose 1-5 stars; also same
  cold-start caveat as the community average.

### Security (rule 13)

- Validate `stars` server-side (integer 1-5); reject anything else.
- Validate `story_id` against a published story before writing.
- Anti-double-rate: unique `(story_id, cookie_token)` + the signed-in partial
  index. Anonymous users can clear cookies and re-rate — harmless for a
  personal-only display; for the future community average add the same
  user_id / heuristic dedup the polls already contemplate.
- Rate-limit the write action.
- **GDPR**: `story_ratings` is user data. Add it to the account-deletion sweep
  (`account-deletion.ts`) and the data-deletion flow alongside `user_likes` etc.
- **Consent**: cookie-keyed writes follow the same `lw_consent` gate the polls
  use — confirm the poll path's exact behavior and match it.
- No PII stored (random cookie token; user_id only when already signed in).

### Lazy-user walkthrough (rule 10)

Tap the star → a 5-star row appears in place → tap a star → it fills and saves
with a visible "Rated ★4" → tap again to change → an obvious clear. Touch-sized
targets on mobile. A signed-in visitor keeps the rating across devices; an
anonymous one keeps it in this browser.

## Phase C — Community average (FUTURE, explicitly deferred)

Aggregate `story_ratings` into a per-story average + count (a rollup table like
`poll_aggregates`, refreshed by a cron). Replace or augment the card score with
the real average once volume justifies it. Retire the fabricated `match %`.

## Open questions

1. "Keep a card score" — keep the fabricated `match %` indefinitely, relabel it,
   or plan to replace it with the Phase C community average? The fake match% is
   a latent honesty issue regardless of ratings.
2. Star picker placement — inline in the action bar, or a small popover?
3. Run the storage-model decision (server cookie-keyed table vs localStorage-
   only) through the LLM council before building Phase B, per rule 11.
