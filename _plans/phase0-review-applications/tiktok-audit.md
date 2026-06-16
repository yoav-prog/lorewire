# TikTok app audit — `video.publish`

TikTok separates two scopes:

- `video.upload` — works in sandbox. Posts land as **drafts** in the
  user's TikTok app; the user must open the app and tap Publish.
- `video.publish` — direct post. **Requires the app to pass audit.**

LoreWire is a publisher. The one-click experience only works with
`video.publish`. Submit the audit Phase 0 day 1; until it clears,
Phase 3 ships with the `video.upload` (drafts) path and the UI labels
the action accordingly.

## Where to file

1. https://developers.tiktok.com/
2. Create or open the app.
3. App configuration → Products → Content Posting API → Enable.
4. App configuration → Scope → request `video.publish`.
5. App information → Submit for review (the form changes when an
   audit-requiring scope is requested).

## Artifacts the form will ask for

| Field | Value |
|---|---|
| App name | LoreWire |
| Category | Tools / Productivity |
| Developer website | `https://lorewire.com` |
| Privacy policy URL | `https://lorewire.com/privacy` |
| Terms of service URL | `https://lorewire.com/terms` |
| App icon | 512×512 PNG, square. |
| Description (short) | LoreWire is a content tool that lets creators publish short videos to their own TikTok account. |
| Description (long) | See justification text below. |
| Contact email | `info@flexelent.com` |

## Justification text

> LoreWire is a server-side publishing tool. Users authenticate their
> own TikTok account via TikTok OAuth, and LoreWire publishes short
> videos to that account only when the user explicitly clicks Publish
> in our editor. We use the Content Posting API's direct-post path
> (`video.publish`) so the user does not have to open the TikTok app
> after clicking Publish on LoreWire. We do not bulk-publish, do not
> publish without user action, and do not read other users' data.
>
> Audio: LoreWire generates the audio track for each short
> ourselves (text-to-speech) or sources it from TikTok's Commercial
> Sound Library where the user opts in. Consumer audio is never used
> from a business-classified account.

## Demo video

Required. Same script as
[`demo-video-script.md`](./demo-video-script.md) covers TikTok.

## Likely bounces

- **"Audio source unclear"**: TikTok cares strongly about audio rights
  because consumer-library tracks aren't licensed for business
  accounts. Explicitly state in the demo and the description that
  LoreWire's default audio source is generated TTS, not trending
  audio, and that the Commercial Sound Library option is opt-in.
- **"App publishes without user action"**: clarify that every publish
  requires a click in the LoreWire UI, no schedulers or background
  jobs publish unsolicited.
- **"Privacy policy doesn't disclose data handling"**: `/privacy`
  Section 5 already names TikTok. Reference the section.

## What clears here

`video.publish` shows "Approved" in the app's scope list, and direct
posts from LoreWire land as live videos on the connected account
instead of as drafts.

## Calendar

1–4 weeks for the audit. Until it clears, Phase 3 (TikTok) ships in
sandbox-only mode with the UI labeled "Save to TikTok drafts."
