# Google OAuth verification — `youtube.upload`

Filed in Google Cloud Console → APIs & Services → OAuth consent screen.
The `youtube.upload` scope is classified as **sensitive**, which means
verification is required regardless of how many users will use the app.

## Where to file

1. https://console.cloud.google.com/
2. Pick or create the project that will hold the OAuth client (a fresh
   project named `lorewire-publisher` is fine; do not reuse a personal
   project).
3. APIs & Services → OAuth consent screen.
4. User Type: **External**. Publish status: prepare for production.
5. After filling everything below, hit "Prepare for verification".

## Fields the form will ask for

| Field | Value |
|---|---|
| App name | LoreWire |
| User support email | `info@flexelent.com` (or your business support address) |
| App logo | 120×120 PNG of the LoreWire logo. **Required for sensitive scopes.** |
| App domain | `lorewire.com` |
| Application home page | `https://lorewire.com` |
| Application privacy policy link | `https://lorewire.com/privacy` |
| Application terms of service link | `https://lorewire.com/terms` |
| Authorized domains | `lorewire.com`, `flexelent.com` (if used for the support email) |
| Developer contact information | `info@flexelent.com` |

## Scopes to request

Add exactly these. Asking for more than you need is the most common
reason for an automatic bounce.

- `https://www.googleapis.com/auth/youtube.upload` — sensitive
- `openid`, `profile`, `email` — non-sensitive, for sign-in UX (optional;
  skip if you don't need the user's email back from Google)

## Justification text Google will ask for

Paste this into the "How will the scopes be used?" box. Edit before
sending if your wording differs from your actual implementation, but
keep it concrete. Reviewers reject vague text.

> LoreWire is a content creation tool. Connected users authorize
> LoreWire to upload videos that LoreWire generated on their behalf to
> their own YouTube channel. The `youtube.upload` scope is used only
> from a server-side route handler that streams the rendered MP4 from
> our Google Cloud Storage bucket directly to YouTube's resumable upload
> endpoint. We do not read user channel data, do not list videos, do
> not modify videos after upload beyond setting a custom thumbnail, and
> do not retain access tokens after the user disconnects.

## Demo video

Required for any sensitive-scope verification. Use the script in
[`demo-video-script.md`](./demo-video-script.md). 60–90 seconds.
Upload to YouTube as **Unlisted** and paste the link.

## Likely bounces and how to dodge them

- **"Scope justification not specific enough"**: rephrase the
  justification to name the exact endpoint (`videos.insert` resumable
  upload) and the exact data flow (Cloud Storage → server route →
  YouTube, never client-side).
- **"Privacy policy doesn't disclose the scope's data usage"**:
  [`/privacy`](../../lorewire-app/src/app/privacy/page.tsx) already
  has a YouTube API Services section naming the scope and the data
  flow. Point to it in the response.
- **"Homepage doesn't function"**: ensure `https://lorewire.com` returns
  200 and the page looks like a real product, not a placeholder.
- **"Logo missing"**: 120×120 PNG, square, no transparency.

## What clears here

A green "Verified" badge on the OAuth consent screen, no
"unverified app" warning shown to users completing the OAuth flow.

## Calendar

1–4 weeks once submitted. Longer if any link in the form 404s at
submission time (reviewers run an automated link checker first).
