# Phase 0 — Platform review applications

Filing checklists for the four serial review gauntlets blocking
[2026-06-16-multi-platform-shorts-publisher.md](../2026-06-16-multi-platform-shorts-publisher.md).

Every day a clock isn't started is a day added to the final ship date.
Submit all four this week. The build (Phase 1+) runs in parallel with
reviewer queues; the calendar critical path is the reviews, not the
code.

## What's already done (this slice)

- [x] [/privacy](../../lorewire-app/src/app/privacy/page.tsx) live and link-checked.
- [x] [/terms](../../lorewire-app/src/app/terms/page.tsx) live and link-checked.
- [x] [Meta data-deletion callback](../../lorewire-app/src/app/api/social/oauth/meta/data-deletion/route.ts) (POST handler, HMAC verification, 9/9 unit tests green).
- [x] [Public deletion-status page](../../lorewire-app/src/app/data-deletion/[code]/page.tsx) at `/data-deletion/<code>`.

## What Yoav owns (before submitting)

- [ ] Decide the legal entity name and confirm contact email. Update
      [`LEGAL_ENTITY`](../../lorewire-app/src/app/privacy/page.tsx) and
      [`CONTACT_EMAIL`](../../lorewire-app/src/app/privacy/page.tsx)
      constants in both `privacy/page.tsx` and `terms/page.tsx`.
- [ ] Decide governing-law jurisdiction. Update `GOVERNING_LAW` in
      [`terms/page.tsx`](../../lorewire-app/src/app/terms/page.tsx).
- [ ] Provision a business-owned Google Workspace account (the OAuth
      identity for YouTube). Never connect Yoav's personal Google
      account to this pipeline.
- [ ] Provision a Meta Business account and complete Business
      Verification (legal-entity KYC). The Meta App Review form will
      not accept submissions before verification.
- [ ] Provision a TikTok for Business account if not already in place.
- [ ] Set environment variables on Vercel:
  - `META_APP_SECRET` (required for the data-deletion callback to
    verify Meta signatures).
  - `NEXT_PUBLIC_SITE_ORIGIN` (set to `https://lorewire.com` so the
    deletion-status URL points at production, not localhost).
- [ ] Deploy the privacy + terms + data-deletion-callback to production
      (`vercel deploy --prod`) so all four review applications can
      reference live URLs.

## Submit, in this order

1. [Google OAuth verification](./google-oauth-verification.md) for the
   `youtube.upload` sensitive scope. Submit first because YouTube quota
   expansion's reviewer often re-reads the same artifacts.
2. [YouTube Data API quota expansion](./youtube-quota-expansion.md).
3. [Meta App Review](./meta-app-review.md) for `instagram_content_publish`,
   `pages_manage_posts`, `publish_video`.
4. [TikTok app audit](./tiktok-audit.md) for `video.publish`.

The four don't actually have to be in order; they can all be filed the
same day. The order above reflects increasing friction so you build
filing-form muscle on the easier ones first.

## What to expect

- **Bounces are normal.** First-submission denial is common across all
  four. The denial reasons are usually "demo video missing", "scope
  justification not specific enough", or "privacy policy doesn't name
  this scope". Fix and resubmit.
- **Calendar**: 1–8 weeks per gauntlet, partially parallel. Plan
  estimates 8–12 weeks before all four publish publicly. See `§15` of
  the main plan.
- **Sandbox-mode reality**: TikTok unaudited apps post as private
  drafts the user must manually publish in-app. Phase 1 (YouTube) does
  not depend on TikTok clearing.

## The demo video

Several of these gauntlets ask for the same recorded screencast.
[`demo-video-script.md`](./demo-video-script.md) is the script — record
once, attach to all four submissions.
