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

### Chosen approach: localStorage now (revised by LLM council 2026-06-22)

Store the rating LOCALLY, reusing the existing `engagement-store.ts` pattern —
one more id→stars map alongside likes/saves, already consent-gated, with the
documented "swap to a server call later" seam. No backend, no new GDPR surface.

This REVERSES this plan's original "server-side now" recommendation. The council
was near-unanimous (4 of 5 advisors + all peer reviewers): a server table to
"pre-collect data for a future community average" is over-engineering for a
zero-traffic product. Anonymous cookie-keyed ratings at this scale are
statistically worthless and untrusted (cookie-clearing, no dedup) — you would
recompute from scratch when real traffic arrives, so the dataset buys almost
nothing while adding real GDPR plumbing on the exact branch paying down GDPR
debt. Cross-device sync at near-zero signed-in users is a phantom requirement.

The council's sharper point, upstream of storage: a personal-only rating that
changes NOTHING visible won't get used (it duplicates "saved"/"liked"). So the
rating must DO something. Decide that payoff before writing storage code.

- **B0 (decide first)** — what does a rating DO for the user? Options: a "Your
  ratings" / 5-star list surface to revisit; feed it into the existing
  personalization; or sort/filter by it. Without a payoff, defer the whole star.
- **B1 Store** — add a `ratingStore` (id→1-5) to `engagement-store.ts`, mirroring
  `useSavedStories` / `useLikedReels`; consent-gated; `useStoryRatings()` hook.
- **B2 UI** — the Rate star opens an inline 1-5 row in both modals; optimistic;
  clear "Your rating ★4"; obvious re-rate / clear.
- **B3 Thumbnails** — render a small "★N" badge on cards the visitor rated
  (mobile + desktop), threaded like the saved/liked sets. Existing card score
  stays as the always-present number.
- **B4** — tests + QA. No new server/GDPR surface, so the security section below
  shrinks to "localStorage + consent gate," same as likes/saves.

### Alternatives rejected

- **Server-side table now (the original plan choice).** Rejected by the council.
  Buys only a low-trust dataset for an unbuilt feature + phantom sync, at real
  GDPR cost. If a community average IS ever greenlit, that decision pays for the
  table then — and the clean way to start collecting is the Contrarian's path:
  persist server-side for SIGNED-IN users keyed by `user_id` only (no anonymous
  cookie token), giving trustworthy identity-deduped data and real cross-device
  sync, without an anonymous-PII swamp. The localStorage store's documented
  swap-seam is where that lands.
- **Community star average now (IMDb-style).** Rejected: cold-start trap on a
  zero-traffic product + clashes with the no-fabricated-counts ethos.
- **Thumbs / % liked.** Rejected: the user chose 1-5 stars; same cold-start caveat.

### Security (rule 13) — localStorage path

With Option B the surface is the same as the existing likes/saves store, so the
security story shrinks accordingly:

- Clamp `stars` to an integer 1-5 in the store before persisting.
- Reuse the existing `lw_consent` gate (the engagement store already skips the
  localStorage write until consent is accepted).
- No server write, no new cookie, no new GDPR/deletion surface — the rating
  never leaves the browser. GDPR data-portability/erasure is covered by the
  existing "clear local data" privacy control that already wipes the store.
- If/when the server path lands (signed-in `user_id` only), THAT change owns
  the validate-on-write, rate-limit, account-deletion + data-deletion sweeps,
  and consent items the original server plan listed.

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

1. **B0 — what does the rating DO?** The council's load-bearing open question: a
   personal-only star that changes nothing visible likely won't get used. Decide
   the payoff (a "Your ratings" list, sort/filter, or feed personalization)
   before building storage — or defer the star entirely.
2. "Keep a card score" — keep the fabricated `match %` indefinitely, relabel it,
   or plan to replace it with the Phase C community average? The fake match% is
   a latent honesty issue regardless of ratings.
3. Star picker placement — inline in the action bar, or a small popover?
4. Storage model — RESOLVED by the LLM council 2026-06-22: localStorage now,
   server table deferred until a community average is actually greenlit.
