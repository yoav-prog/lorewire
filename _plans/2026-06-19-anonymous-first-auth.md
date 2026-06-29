# Anonymous-first auth with progressive registration

Date: 2026-06-19
Status: Phase 1 + 2 + 3 SHIPPED. Phase 4 + 5 + 6 pending.

## Goal

Let any visitor use LoreWire fully without signing up. Anonymous identity is durable
on this browser via cookie + localStorage. Registration exists for one reason only:
**to sync state across devices**, and we ask for it only at a value moment, never
on landing.

Modeled on the Netflix-style frictionless onboarding pattern Yoav agreed with his
boss on 2026-06-17. Two stages:

1. Anonymous user with Local Storage + a stable `lw_anon` cookie nonce.
2. Soft prompt at a value moment: "Want to keep your saved stories across
   devices?" with three sign-in options.

## Locked decisions (Yoav, 2026-06-19)

1. **Architecture: cookie-anon + localStorage, lift-and-shift on register.**
   No DB row for anonymous visitors. (Alternatives rejected: anonymous DB
   row from first visit — GDPR + DB cost overhead with no near-term
   recommendation use case; pure localStorage with no anon cookie —
   makes future server-side personalization impossible without
   re-architecture.)
2. **Provider v1: Google OAuth + Microsoft OAuth + email magic link**
   (live-verified all three are free at launch scale).
   - **Google OAuth** — free, no MAU cap. Covers Gmail/Workspace users.
   - **Microsoft OAuth** (Entra External ID) — free up to 50,000 MAU.
     Covers Outlook/Hotmail/Live/Xbox accounts.
   - **Email magic link** via Brevo (9,000 emails/month free forever).
     Better UX than passwords. AWS SES fallback at scale (~$0.10/1k).
   Apple Sign-In deferred ($99/yr Apple Developer Program with no
   near-term iOS app).
3. **Prompt threshold:** first save fires a non-blocking slide-up sheet
   (does not interrupt the save itself). "Maybe later" snoozes 7 days. A
   persistent low-friction "Save across devices →" link in the My List
   header is always visible.
4. **Session separation:** new `lw_user` cookie + new `src/lib/user-session.ts`
   helper, strictly separate from the admin `lw_session` /
   `src/lib/session.ts`. No way for an admin scope to leak into a
   public-side helper.
5. **Cookie consent banner:** non-blocking bottom banner with Accept /
   Reject. Reject leaves the user in pure-ephemeral mode (no `lw_anon`,
   no localStorage persistence). Grandfather branch: if the browser
   already has prior persistent state (`lw.saved.v1`, `lw.liked.v1`, or
   `lw_vote` cookie), silently accept on first run — existing users
   don't see a retroactive banner.

## Constraints

- Build, don't rent (Yoav memory). No third-party auth SaaS. Google +
  Microsoft consumed via `arctic` (a library, not a SaaS). Brevo's
  free tier consumed via a direct REST call (no SDK dependency).
- "This is NOT the Next.js you know" (lorewire-app/AGENTS.md). Read
  the in-repo guides at `node_modules/next/dist/docs/` before writing
  route handlers / middleware. Context7 consulted for arctic + Brevo
  before implementation.
- One schema, one migration path (SQLite local / Postgres prod via
  `DATABASE_URL`). Use the additive ALTER pattern already proven in
  `src/lib/schema.ts`.
- Reuse `engagement-store.ts`'s pre-instrumented seam: same hook
  signatures, internals branch on "have session? server : localStorage".

## Architecture

### Storage layout

```
Anonymous (no DB rows):
  cookie  lw_anon       = 256-bit nonce, HttpOnly, 365d, SameSite=Lax
  cookie  lw_consent    = "accepted" | "rejected", non-HttpOnly, 365d
  ls      lw.saved.v1            (My List — exists)
  ls      lw.liked.v1            (Liked reels — exists)
  ls      lw.fav_categories.v1   (new, Phase 2)
  ls      lw.recently_viewed.v1  (new, Phase 2; cap 50, LRU)
  ls      lw.continue.v1         (new, Phase 2; per-story progress, cap 20)
  ls      lw.consent.ping        (cross-tab consent change marker)
  ls      lw.prompt_snooze.v1    (planned Phase 5; "maybe later" snooze)

Registered:
  cookie  lw_user       = signed JWT, 7d, separate USER_SESSION_SECRET
  DB      users(... + name, picture_url, provider, provider_sub,
                anonymous_id, last_seen_at)
  DB      user_saves, user_likes, user_fav_categories,
          user_recently_viewed, user_continue
  DB      magic_link_tokens(id, email, token_hash, expires_at, used_at, ...)
  DB      poll_votes.user_id  (Phase 3 column — reconciled on first sign-in)
```

### File layout

Foundation (Phase 1):
- `src/lib/anon.ts` — `lw_anon` cookie issue/read/clear (server-only).
- `src/lib/consent.ts` — `lw_consent` cookie server helpers; on accept,
  also issues `lw_anon`.
- `src/lib/consent-client.ts` — client store (useSyncExternalStore) +
  POST helper + grandfather detection.
- `src/app/api/consent/route.ts` — POST `accepted` | `rejected`.
- `src/components/CookieConsent.tsx` — non-blocking bottom banner, EN +
  HE copy, focus-on-mount.
- `src/components/AppShell.tsx` — mounts the banner once for both
  mobile + desktop shells.
- `src/lib/engagement-store.ts` — consent gate on toggles.
- `src/lib/schema.ts` — additive `users` columns + 5 new user_* tables
  + `poll_votes.user_id` + matching partial unique indexes.

Per-user state (Phase 2):
- `useFavoriteCategories()`, `useRecentlyViewed()`, `useContinueReading()`
  added to `engagement-store.ts` using the same SSR-safe
  useSyncExternalStore pattern.
- `homepage-rails.ts` — `resolveRailIds` gains a `userOverrides` param.
  Continue rail resolution order: admin curation → user state → catalog.
- `ReelCard.tsx` gains `onTimeUpdate` prop.
- `ReelsFeed.tsx` throttles position writes (≥5s watched, <90% complete
  writes; ≥90% removes the entry).
- Both shells wire `recordView` on `open()` and `openReels()`.

Auth + sign-in (Phase 3):
- `src/lib/user-session.ts` — `lw_user` JWT cookie (separate
  USER_SESSION_SECRET).
- `src/lib/users.ts` — three-branch identity resolution
  (provider+sub → email-link → create) with **admin-row link refusal**
  as the privilege-escalation guard.
- `src/lib/oauth-cookies.ts` — shared OAuth bookkeeping cookies +
  `sanitizeNext` (open-redirect blocker).
- `src/lib/oauth-google.ts` — `arctic.Google` + id_token JWKS
  verification with mandatory `email_verified` check.
- `src/lib/oauth-microsoft.ts` — `arctic.MicrosoftEntraId` with
  multi-tenant issuer regex.
- `src/lib/magic-link.ts` — token issue/consume (hash-only at rest,
  per-call random marker for race-safe consume) + Brevo REST send.
- `src/lib/poll-vote-reconciliation.ts` — `UPDATE poll_votes SET user_id
  WHERE cookie_token = ? AND user_id IS NULL`.
- `src/app/auth/google/{start,callback}/route.ts`.
- `src/app/auth/microsoft/{start,callback}/route.ts`.
- `src/app/auth/magic-link/{request,verify}/route.ts`.
- `src/app/auth/signout/route.ts`.
- `src/app/auth/signin/page.tsx` + `SignInForm.tsx`.

### Sign-in flow (PKCE OAuth)

1. User clicks "Continue with Google" → `/auth/google/start`.
2. Server generates `state`, `codeVerifier`, optional `next` cookie
   (sanitized). Stores in HttpOnly cookies (10-min TTL). Redirects to
   Google.
3. Google redirects to `/auth/google/callback?code=...&state=...`.
4. Server checks state match, exchanges code for tokens via arctic.
5. Server verifies id_token signature (JWKS), iss, aud, exp,
   `email_verified === true`.
6. `upsertUserOnSignIn` — provider+sub lookup, falls back to email,
   creates if neither found. REFUSES to link onto an admin row.
7. If first sign-in for this browser: run `reconcileVotesForCookieToken`
   to promote anonymous poll votes to the new user_id.
8. Issue `lw_user` cookie. Redirect to `next` (validated) or `/`.

Microsoft flow is identical with `oid` claim as provider_sub. Magic link
follows the same upsert + reconcile + session-issue steps but uses
email-as-provider_sub (no third-party identity layer).

### Polls + auth integration

`poll_votes.user_id` is nullable. Anonymous votes leave it NULL and stay
anchored to `cookie_token`. Signed-in votes set `user_id`. Two partial
unique indexes:
- `idx_poll_votes_poll_cookie` (existing, on cookie_token) for anon votes.
- `idx_poll_votes_poll_user WHERE user_id IS NOT NULL` (new) for
  signed-in votes.

On first sign-in: `UPDATE poll_votes SET user_id = ? WHERE cookie_token
= ? AND user_id IS NULL`. The two WHERE conditions are load-bearing —
the `cookie_token` clause scopes to THIS browser, the `user_id IS NULL`
clause caps to anonymous-only votes. Without either, sign-in could
clobber another user's authenticated votes or promote every anonymous
vote in the system.

### Cookie consent state machine

```
First-run grandfather (one-time per browser):
  lw_consent unset + (lw.saved.v1 entries OR lw.liked.v1 entries OR
  lw_vote cookie) → silently POST /api/consent {accepted}.

Fresh visit (no consent + no prior state):
  Show banner. Accept → POST sets lw_consent + lw_anon.
  Reject → POST sets lw_consent + clears lw.saved.v1 + lw.liked.v1.

After consent decided:
  engagement-store toggles persist normally on accepted; in-memory
  only on rejected/undecided (consent gate inside the toggle).

Manage Cookies link (Phase 6):
  Dispatches lw:consent:reopen → banner re-shows.

After sign-in:
  lw_user is strictly-necessary; signing in implies consent.
```

## Security (rule 13)

- All cookies HttpOnly except `lw_consent` (read directly by client UI).
  Secure in prod, SameSite=Lax everywhere.
- `SESSION_SECRET` (admin) and `USER_SESSION_SECRET` (public) are
  independent env vars — never share key material.
- Google + Microsoft OAuth: PKCE everywhere. id_token verification:
  signature against JWKS, iss, aud, exp, nonce-via-state, and
  `email_verified === true` for Google. Reject unverified emails — the
  single line that prevents account-takeover via a forged Google account
  claiming an email the attacker doesn't control.
- Cross-provider email link is ALLOWED for `role='user'` rows only.
  For admin rows: `upsertUserOnSignIn` throws — prevents OAuth identity
  from gaining admin scope via shared email.
- Magic link tokens: 256-bit random, hashed at rest, 15-minute TTL,
  single-use enforced via per-call random marker (defeats sub-ms
  consume race).
- `sanitizeNext` blocks open-redirects: rejects protocol-relative
  URLs, full URLs, backslash tricks, paths without leading slash.
- Rate limit on magic-link request (reuses `lib/poll-rate-limit`).
- No PII in logs: emails appear only as 8-char `hashForLog` (SHA-256
  prefix) so support can correlate without leaking PII.

## Testing (rule 18)

Phase 1+2+3 ship with 75+ unit tests across:
- `anon.test.ts` — token shape + entropy.
- `consent-client.test.ts` — cookie parse + grandfather detection.
- `engagement-store.test.ts` — module surface (full gate behavior in
  Phase 6 manual QA).
- `homepage-rails.test.ts` — Continue rail resolution order
  (admin → user → catalog fallback).
- `schema.test.ts` — extended with assertions for all 6 new partial
  unique indexes + `users(provider, provider_sub)` + magic_link_tokens
  hash index.
- `user-session.test.ts` — JWT round-trip + tampering + secret rotation.
- `users.test.ts` — three-branch identity resolution + admin-row link
  refusal + email normalization + name/picture preservation.
- `magic-link.test.ts` — issue/consume happy path + double-consume +
  expiry + **concurrent-consume race** (caught a real bug in the first
  implementation, fixed with per-call random marker).
- `oauth-cookies.test.ts` — `sanitizeNext` rejects every classic
  open-redirect attack vector.
- `poll-vote-reconciliation.test.ts` — UPDATE bounded to
  `user_id IS NULL`, scoped to matching cookie token.

Out of scope for unit tests, manual QA in Phase 6:
- Real Google + Microsoft OAuth round-trips (requires registered
  client + redirect URI).
- Brevo email deliverability.
- Hebrew RTL banner rendering.

## Phases

1. **Schema + anon cookie + cookie consent banner.** SHIPPED.
2. **Extend engagement-store + new state buckets.** SHIPPED.
3. **Sign-in with Google + Microsoft + magic link.** SHIPPED. Includes
   poll-vote reconciliation on first sign-in, separate `lw_user`
   session, and the `/auth/signin` page.
4. **State sync.** Pending. `/api/user/sync` + `/api/user/state`,
   `engagement-store.ts` branches on `lw_user`, polls `recordVote` writes
   user_id when signed in.
5. **Cross-device nudge.** Pending. Slide-up sheet on first save, 7-day
   snooze, persistent "Save across devices →" link in the My List
   header.
6. **Polish + a11y + observability sweep.** Pending. Reduced motion,
   keyboard, focus management, RTL/LTR, log review, friendlier
   PollWidget error mapping (replace raw "forbidden origin" text), manual
   QA pass.

## Env vars (Phase 3)

Added to `.env.example`:
- `NEXT_PUBLIC_SITE_ORIGIN` — must be set in prod for OAuth redirect
  + the polls + consent origin gates.
- `USER_SESSION_SECRET` — JWT signing key for `lw_user` cookie.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Google OAuth.
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT`
  (default `common`).
- `BREVO_API_KEY`, `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME` — magic-link
  send.

## Rejected alternatives (recorded so we don't relitigate)

- **Anonymous DB row from first visit.** GDPR + DB-write cost per
  unique browser (incl. bots) outweighs the benefit. Can be retrofit
  by promoting the `lw_anon` cookie to a row later.
- **Pure localStorage, no anon cookie.** Forecloses server-side
  personalization without a re-architecture.
- **Apple Sign-In in v1.** $99/yr Apple Developer Program; no
  near-term iOS app.
- **Email + password instead of magic link.** Password fatigue UX
  regression; magic link covers the same demographic for free.
- **Auth.js / NextAuth.** Forces a rewrite of `session.ts` or runs
  two parallel session systems.
- **Single session cookie covering admin + public.** Privilege
  escalation surface is too wide; strict separation removes the
  entire class of bug.
- **Modal/blocking nudge after first save.** Hostile to a frictionless
  product. Slide-up non-blocking is the smallest delta that respects
  the lazy-user bar.
- **No cookie banner.** Technically not legally required (all our
  cookies are functional), but Yoav asked for one explicitly.
- **Brevo SDK.** ~500 KB dep for a one-endpoint use case; direct REST
  is ~20 lines.

## What this work does NOT change

- Admin auth (`lw_session`, `users` admin rows, `passwords.ts`)
  untouched.
- The pipeline (`pipeline/`) untouched.
- Public reading paths (`/v/[slug]`, `/articles/[locale]/[slug]`,
  homepage, reels) gain auth-aware affordances in Phase 4+ but data
  contracts don't change.
- Polls' `lw_vote` cookie keeps its anti-double-vote role; new
  `poll_votes.user_id` is additive.
