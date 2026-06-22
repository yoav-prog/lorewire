# Facebook login + real data deletion

Date: 2026-06-22
Branch: feat/multi-platform-shorts-publisher
Status: approved, implementing

## Goal

Add "Continue with Facebook" sign in / sign up alongside the existing
providers, and turn the existing Meta data-deletion callback from a
log-only stub into a callback that actually deletes a user's data, as
Meta requires for any app using Facebook Login.

## What the user asked for

> make signup/sign in via facebook as well please
> and mind this https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback

## Decisions locked with the user (2026-06-22)

1. **Deletion scope: delete the whole account.** When Facebook sends a
   data-deletion request for a Facebook-login user, wipe the `users` row
   plus all per-user state, and re-anonymize their poll votes. A
   Facebook-login user has no password and no second login path in this
   schema, so an anonymized shell would be unreachable dead data.
2. **One Meta app, already created.** Facebook login uses the same Meta
   app that `META_APP_SECRET` belongs to. The single existing
   data-deletion callback therefore covers login users too, because the
   app-scoped `user_id` in the signed_request equals the `provider_sub`
   we store at login (verified: both are the app's app-scoped ID / ASID).
3. **Add a self-serve "Delete my account" control** in the account page,
   reusing the same deletion logic. Better GDPR posture and works for all
   users, not only Facebook ones.

## Verified facts (do not guess — re-checked at build time)

- `arctic` 3.7.0 (lockfile). `new arctic.Facebook(clientId, clientSecret, redirectURI)`.
  `createAuthorizationURL(state, scopes)` — **no PKCE** (same shape as Reddit).
  `validateAuthorizationCode(code)` — **does NOT throw `arctic.OAuth2RequestError`**
  (Facebook's error responses are non-RFC). So the callback must not copy
  Reddit's `instanceof OAuth2RequestError` branch.
- Identity: `GET https://graph.facebook.com/me?access_token=...&fields=id,name,picture,email`.
  Scopes `email` + `public_profile` are pre-approved (no App Review for basic login).
- Email is optional in Facebook Login (user may deny it / phone-only account).
  Facebook only returns confirmed emails, so a present email is treated as
  verified and is merge-eligible (subject to the existing squatter guard).
- **Cost: Facebook Login is free.** `email`/`public_profile` need no review.
  Business Verification (free) only applies to sensitive permissions we don't use.
- Data-deletion callback: POST `signed_request`, must return
  `{ url, confirmation_code }`. The existing endpoint already returns this shape.

## Chosen approach

### A. Facebook login (mirror the Reddit provider)

- `src/lib/oauth-facebook.ts`: `readFacebookConfig()`, `buildFacebookClient()`,
  `fetchFacebookIdentity(accessToken)`.
  - clientId from `FACEBOOK_CLIENT_ID` (the Meta App ID; not secret).
  - **clientSecret from `META_APP_SECRET`** (single source of truth, shared
    with the deletion verifier). We deliberately do NOT add a separate
    `FACEBOOK_CLIENT_SECRET` env: if the login secret and the deletion-callback
    secret ever drifted, HMAC verification of login users' deletion requests
    would silently fail. (Drift trap flagged by the council Executor.)
  - Identity: real email when present (merge-eligible); when absent, synthesize
    `<fbid>@facebook.user.lorewire.invalid` (mirrors Reddit) so the row anchors
    to itself and never merges by email.
- Routes `src/app/auth/facebook/start/route.ts` and `.../callback/route.ts`,
  cloned from Reddit, minus the `OAuth2RequestError` branch. Reuse
  `upsertUserOnSignIn()` untouched (don't fork it — that's how Reddit/Google break).
- `UserProvider` gains `"facebook"`. `oauth-cookies.ts` gains `FACEBOOK_STATE_COOKIE`.
- Shared `OAuthButtons` client component (extracted from SignInForm) rendered on
  BOTH the sign-in page and the sign-up page, so a lazy user who lands on
  "Create account" can still use Facebook. Brand color #1877F2, gated server-side
  on `readFacebookConfig()`.

### B. Real deletion

- `src/lib/account-deletion.ts`:
  - `USER_DATA_TABLES`: a single declared list of every table keyed by `user_id`
    (the council Expansionist's one cheap generalization — so a future feature
    table can't silently leave data behind). Today: user_saves, user_likes,
    user_fav_categories, user_recently_viewed, user_continue.
  - `deleteUserCompletely(userId)`:
    1. DELETE from each `USER_DATA_TABLES` table WHERE user_id = ? (satellites first).
    2. UPDATE poll_votes SET user_id = NULL, cookie_token = NULL, ip_ua_hash = NULL
       WHERE user_id = ? (re-anonymize — keep the aggregate tally, sever every
       identifier; addresses the council's pseudonymization catch).
    3. DELETE the `users` row LAST.
    Ordering gives crash-safety without a transaction (the codebase uses no
    transactions anywhere): a mid-failure leaves the `users` row intact, so the
    account stays findable by `provider_sub` and a retry completes. Each step is
    idempotent (DELETE/UPDATE WHERE user_id are naturally idempotent).
  - `recordDeletionRequest(...)`: insert-or-ignore into `data_deletion_requests`
    keyed by confirmation_code (so Meta retries don't double-log). Stores only a
    one-way `subject_hash` (no raw PII), the source, whether a row was deleted,
    and created_at.
- Schema: add `DATA_DELETION_REQUESTS` table + register it in TABLES.
- Extend `src/app/api/social/oauth/meta/data-deletion/route.ts`: after verifying
  the signed_request, look up `users WHERE provider='facebook' AND provider_sub=user_id`;
  if found, `deleteUserCompletely`. **Log the matched-row count and WARN on
  verified-signature-but-zero-match** so a silent no-op can never look like success
  (council Contrarian). Still return `{ url, confirmation_code }`; return 500 only
  on an internal deletion error so Meta retries.
- `src/app/data-deletion/[code]/page.tsx`: look the code up; show "completed" +
  date when found, generic message otherwise. **Rewrite the copy in plain
  language** — drop "revoked stored access tokens" (meaningless to a normal user
  and wrong for login users, who have no stored token). Say what was actually
  deleted: account, saved stories, likes, history, and that votes were anonymized.

### C. Self-serve delete

- `src/app/api/user/delete/route.ts`: authed POST. Reuse the `isAllowedOrigin`
  same-origin gate (CSRF defense, same as login/signout). Read session →
  `deleteUserCompletely(session.userId)` → `deleteUserSession()` (clear cookie
  AFTER the delete succeeds, not before) → log → `{ ok: true }`.
- `src/app/auth/account/DeleteAccount.tsx`: a clearly-separated "Danger zone"
  with an explicit confirmation step that spells out exactly what dies and that
  it's permanent (council Outsider — no one-click irreversible delete on mobile).
  On success, hard-navigate home.

## Alternatives rejected

- **Build an `identities` table first** (split account from identity, fix the
  "last-provider-wins" merge wart). Correct long-term and raised by the council
  First-Principles advisor, but it's a migration of a live auth model the user
  didn't ask for. Deferred to its own scoped refactor; recorded here so it isn't
  lost. Full-account-delete is honest under the current single-row model because
  at deletion time the row only represents the Facebook identity anyway.
- **Unlink Facebook instead of deleting** — rejected by the user (decision 1) and
  leaves unreachable orphan data.
- **Hard-delete poll_votes** — rejected; corrupts aggregate tallies for no privacy
  gain once every identifier on the row is nulled.
- **Interactive "is this you?" account linking** instead of silent email merge —
  a real UX improvement (council Outsider) but a system-wide change affecting
  Google/Microsoft too. Out of scope; Facebook matches existing behavior.
- **A second `FACEBOOK_CLIENT_SECRET` env** — rejected for drift-safety (see A).
- **Add a DB transaction primitive** — rejected; the codebase uses none, and
  ordered idempotent deletes give equivalent crash-safety here.

## Security (rule 13)

- Deletion callback authenticated by HMAC-SHA256 over `META_APP_SECRET`
  (existing `parseSignedRequest`, timing-safe). Self-serve delete behind the
  session cookie + same-origin gate. No raw Facebook id, email, or user id is
  logged — only `hashForLog` digests and the email domain.
- The signed_request is replayable (no nonce in the basic format), but replay
  only re-deletes an already-deleted account (idempotent no-op), so there is no
  takeover or amplification surface.
- Squatter guard is unchanged and applies to Facebook identically.
- poll_votes re-anonymization nulls user_id + cookie_token + ip_ua_hash, leaving
  no residual identifier on the retained aggregate row.

## QA / tests

- `oauth-facebook.test.ts`: config present/absent gating; identity parsing with
  email present and absent (synthetic anchor); missing-id throws.
- `account-deletion.test.ts`: deletes every USER_DATA_TABLES table + users row,
  nulls all three poll_votes identifiers, idempotent on a second call, log row
  written once. Run against the SQLite path; SQL is portable to Postgres.
- Extend the data-deletion behavior coverage: valid signed_request deletes a
  matching facebook user; bad HMAC rejected; unknown user is a logged no-op that
  still returns `{ url, confirmation_code }`.
- Manual: sign-in + sign-up Facebook buttons render only when configured; do not
  regress the Google/Microsoft/Reddit layout; self-serve delete confirm flow.

## Go-live checklist (Meta dashboard — operator, not code)

- Add `https://lorewire.com/auth/facebook/callback` to Valid OAuth Redirect URIs.
- Add `http://localhost:3000/auth/facebook/callback` for local dev.
- Set the Data Deletion Request URL to
  `https://lorewire.com/api/social/oauth/meta/data-deletion` and use Meta's
  "Send test" tool to confirm it returns `{ url, confirmation_code }`.
- Set `FACEBOOK_CLIENT_ID` (Meta App ID) and confirm `META_APP_SECRET` is set.
- Switch the app to Live mode; confirm `email`/`public_profile` are granted.

## Open questions / future work

- `identities` table refactor (multi-provider per account) — separate effort.
- Interactive account-link confirmation across all providers — separate UX pass.
- Token revocation on Meta's side — a publisher-phase concern; login stores no token.
- "Download my data" export reusing USER_DATA_TABLES — nice future trust signal.
