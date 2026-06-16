# Meta App Review — Facebook Reels + Instagram Reels

The Meta gauntlet has the most artifacts and the longest tail. Two
serial gates: Business Verification (the legal-entity KYC step) then
App Review (the per-permission audit).

## Where to file

1. https://developers.facebook.com/apps
2. Create an app of type **Business**.
3. App settings → Basic → fill the artifacts below.
4. App Review → Permissions and features → request each scope.
5. App Review → Business Verification → start the KYC flow.

## Artifacts the form will ask for

| Field | Value |
|---|---|
| App display name | LoreWire |
| App contact email | `info@flexelent.com` |
| Business use | Tools (Content publishing) |
| Privacy policy URL | `https://lorewire.com/privacy` |
| Terms of service URL | `https://lorewire.com/terms` |
| Data deletion callback URL | `https://lorewire.com/api/social/oauth/meta/data-deletion` |
| App icon | 1024×1024 PNG, square, no transparency. |
| App category | Productivity |
| App domains | `lorewire.com` |

The data-deletion callback **must verify when reviewed**. Ours posts
to it with a test `signed_request`; if `META_APP_SECRET` is not set on
Vercel before submission, reviewers see a 500 and bounce. Set it
first.

## Permissions to request

Ask for exactly these. Adding extras delays the whole review.

- `instagram_basic` — read basic profile of the connected IG account.
- `instagram_content_publish` — create Reels containers and publish them.
- `pages_show_list` — list the Pages the connected user can manage.
- `pages_read_engagement` — read post engagement for the metrics loop.
- `pages_manage_posts` — create posts on a Page.
- `publish_video` — required for Reels uploads on Facebook Pages.

## Justification text (per permission)

Meta requires a short explanation **per scope**. Paste these in, edit
to match exact wording of your implementation.

### `instagram_basic` + `instagram_content_publish`

> LoreWire users connect their Instagram Business account so LoreWire
> can publish Reels they created in our editor to their own account.
> We use `instagram_basic` only to display "connected as
> @username" in our settings page, and `instagram_content_publish`
> only when the user clicks Publish on a specific short. We do not
> publish without explicit user action.

### `pages_show_list` + `pages_manage_posts` + `publish_video`

> LoreWire users connect a Facebook Page so LoreWire can publish Reels
> they created to that Page. `pages_show_list` is used during the
> connect flow to let the user pick which Page to connect.
> `publish_video` is used only when the user clicks Publish.
> `pages_manage_posts` is not used to create unsolicited posts — only
> as a dependency of the video-publish flow.

### `pages_read_engagement`

> LoreWire reads post engagement (view count, watch time, reactions,
> shares) for posts the user published through LoreWire, on the cadence
> the user opts into (1h / 24h / 7d after publish). The data is shown
> back to the same user in LoreWire's metrics view. It is not shared
> with third parties.

## Demo video

Required per permission. Same script as
[`demo-video-script.md`](./demo-video-script.md) — the script covers
both YouTube and Meta flows so the same recording satisfies both.

Meta is stricter than Google: the video must literally show the
permission being used (the publish button clicked, the post landing on
IG/FB, the engagement being read back). Wireframes are not accepted —
they want the real running app.

## Business Verification

Separate from App Review. Requires legal-entity KYC: business
registration document, address, beneficial owner. This is the slowest
step for a fresh entity. Start it the same day you create the app;
don't wait for App Review.

## Likely bounces

- **"Data deletion callback returned an error"**: ensure
  `META_APP_SECRET` is set on Vercel BEFORE you submit. Reviewers test
  the endpoint with a signed test request.
- **"Demo video doesn't show the permission in use"**: re-record with
  the actual publish button visible and the IG/FB post landing on-screen.
- **"Privacy policy doesn't mention IG/FB data handling"**:
  `/privacy` already names Meta in Section 5 (Sharing) and disclaims
  re-sale and advertising use. Reference the section number in the
  response.
- **"Business Verification incomplete"**: blocks all App Review.
  Finish KYC first.

## What clears here

The app moves from Development mode to Live mode, and the requested
permissions show "Approved" instead of "Submission required" on the
App Review page.

## Calendar

- Business Verification: 1–4 weeks for a fresh entity.
- App Review per permission: 1–6 weeks. Running in parallel after
  Business Verification clears.
- Total: 2–10 weeks before IG Reels and FB Reels can publish publicly.
