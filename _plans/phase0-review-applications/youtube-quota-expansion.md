# YouTube Data API v3 — quota expansion

Default daily quota is 10,000 units. `videos.insert` costs **1,600
units** per upload, so the default ceiling is roughly **6 uploads per
day**. That's a hard wall on Phase 1 volume. Submit the expansion form
the same week you submit Google OAuth verification — both reviewers
look at the same artifacts.

## Where to file

1. https://console.cloud.google.com/
2. Same project that holds the OAuth client from
   [`google-oauth-verification.md`](./google-oauth-verification.md).
3. APIs & Services → YouTube Data API v3 → Quotas → "Request quota
   increase" (the link is in the page header, not the table row).
4. Or directly: `https://support.google.com/youtube/contact/yt_api_form`.

## Fields and answers

The audit form has changed over the years; the current shape (as of
mid-2025) asks for the items below. Re-verify the form at submission
time — if any field name differs, match by intent.

| Field | Answer |
|---|---|
| Project number | The numeric ID shown in Cloud Console (top-right corner). |
| App name | LoreWire |
| Website | `https://lorewire.com` |
| YouTube channel ID used for testing | The channel ID of the business-owned channel that will receive Phase 1 uploads. |
| OAuth client ID | The client ID created in OAuth verification. |
| Are you using YouTube API to display, sort, or download YouTube data? | No. We use it exclusively to upload videos created by our users to their own channels. |
| What features of your app rely on YouTube? | Upload of generated short videos to the connected user's YouTube channel; setting a custom thumbnail after upload; reading basic post status (views, watch time) for the user's own posts when the user opts in. |
| Do you use YouTube data to train ML models? | No. |
| Will the app be made available to end users? | Yes. The user must explicitly authorize the YouTube scope and click Publish per video. No automated unsolicited uploads. |
| Estimated daily `videos.insert` calls | Start with 40/day. Reviewers prefer realistic small numbers over inflated ones. Expansion can be re-requested later. |
| Why is the default quota insufficient? | Default 10,000 units = ~6 uploads/day. Our users render and publish more than that in a typical work session. |
| Compliance with YouTube API Services Terms of Service | Confirmed. |

## Required artifacts (same as Google OAuth verification)

- Privacy policy URL: `https://lorewire.com/privacy` — must reference
  YouTube API Services and Google Privacy Policy ([already done](../../lorewire-app/src/app/privacy/page.tsx)).
- Terms of service URL: `https://lorewire.com/terms`.
- Demo video URL: see [`demo-video-script.md`](./demo-video-script.md).

## Likely bounces

- **"Daily call estimate is too high without justification"**: drop
  the number, re-submit. Approvals come faster at modest asks.
- **"Compliance audit incomplete"**: re-confirm you've read and follow
  the YouTube API Services Terms of Service. The form has a checkbox
  for this; check it.
- **"Privacy policy missing YouTube disclosures"**: the existing
  `/privacy` already has Section 6 "YouTube API Services". Point at
  it explicitly in the response.

## What clears here

A new, higher daily quota (typically 50,000–1,000,000 units depending
on the ask) visible on the YouTube Data API v3 quotas page.

## Calendar

2–8 weeks. First-pass denial is common for solo operators; the
re-submit clock then runs 1–4 more weeks.
