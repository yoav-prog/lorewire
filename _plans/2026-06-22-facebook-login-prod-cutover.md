# Facebook login — production cutover (Meta App Review unblock)

Date: 2026-06-22
Production branch (Vercel): `feat/r2-media-migration` (confirmed with user; main is 90 commits behind and is NOT the deploy source)
Status: approved (strategy: "add FB+GDPR to the live branch"), executing

## Why this plan exists

Meta App Review for Facebook Login can't pass because the Facebook code was
never deployed: `www.lorewire.com/auth/signin` 500s, `/auth/signup` has no
Facebook button, `/auth/facebook/start` 404s. The code is sound (clean commit
`96b0bd4` on `feat/facebook-login`, mirrored uncommitted in the live branch's
working tree). This is a release + env problem, not a code problem.

## Hard facts established

- Production deploys from `feat/r2-media-migration`, whose working tree mixes
  three unshipped features: Facebook login, GDPR account-deletion, and admin
  user-management (Phase 0-3). Only Facebook should ship in this cutover.
- The Facebook change set is separable. Pure-FB files commit whole; `users.ts`
  needs hunk-level staging (`| "facebook"` only; leave the `status`/`suspended`
  admin hunks uncommitted).
- The live signin 500 is almost certainly an OAuth provider config reader
  throwing because `NEXT_PUBLIC_SITE_ORIGIN` is unset in prod (every reader:
  `if (!clientId || !clientSecret) return null;` then `if (!origin) throw`).
  Setting that env var both fixes the 500 and is required for the FB redirect.

## Scope decision (open — see "Decisions needed")

- A) FB login only. Lowest risk; unblocks the review now. The deployed
  data-deletion callback already returns `{ url, confirmation_code }` (the shape
  Meta checks). Real deletion (account-deletion.ts) follows as a fast-follow.
- B) FB login + real deletion. Closes the compliance gap (callback actually
  deletes) but pulls in schema + repo changes that partly overlap the admin
  work; larger, higher-risk commit.

## Execution steps

1. Stage Facebook-only on `feat/r2-media-migration`:
   - whole: `oauth-facebook.ts`, `auth/facebook/start`, `auth/facebook/callback`,
     `auth/_components/OAuthButtons.tsx`, `auth/signin/page.tsx`,
     `auth/signin/SignInForm.tsx`, `auth/signup/page.tsx`, `oauth-cookies.ts`
   - hunk only: `users.ts` → the `| "facebook"` addition to `UserProvider`
2. Verify green: typecheck + `oauth-facebook` tests (+ `account-deletion` tests if scope B).
3. Commit locally (no push yet). Hand the commit to the user to review.
4. User sets Vercel production env (see below) — do this BEFORE/with the deploy.
5. Push → Vercel production deploy.
6. User configures Meta dashboard (see below).
7. Verify live end-to-end, then paste reviewer instructions and submit.

## Vercel production env (operator — API is SAML-locked, dashboard only)

- `NEXT_PUBLIC_SITE_ORIGIN=https://www.lorewire.com`  ← fixes the 500 + builds the redirect URI
- `USER_SESSION_SECRET=<token_hex(32)>`               ← signs the lw_user cookie
- `FACEBOOK_CLIENT_ID=<Meta App ID>`
- `META_APP_SECRET=<Meta App Secret>`                 ← also used by the deletion callback
- verify already set: `DATABASE_URL`, `BREVO_API_KEY`

## Meta dashboard (operator)

- Valid OAuth Redirect URIs: `https://www.lorewire.com/auth/facebook/callback`
  (MUST match NEXT_PUBLIC_SITE_ORIGIN's host exactly — www vs apex matters)
- Data Deletion Request URL: `https://www.lorewire.com/api/social/oauth/meta/data-deletion`
- Set the app to Live mode; confirm `email` + `public_profile` are granted.

## Verify live (gates the review submission)

- `https://www.lorewire.com/auth/signin` returns 200 and shows "Continue with Facebook"
- Full round-trip: click → Facebook consent → redirected back signed in
- `/auth/account` shows the Facebook name + avatar
