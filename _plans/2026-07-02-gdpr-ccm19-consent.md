# CCM19 consent management integration

Date: 2026-07-02
Status: approved (direct user request: "for gdpr, we need to implement CCM19")
Branch: `feat/gdpr-ccm19-consent`
Parent plan: `_plans/2026-06-22-gdpr-compliance.md` (this closes the council's
"consent records" gap flagged as non-negotiable there)

## Goal

Put CCM19 in front of users as the consent banner and the auditable
consent-record layer, without breaking the in-app consent plumbing that
already gates analytics and device storage. Yoav has an active CCM19
account (hosted at team.epccm19.com, snippet with apiKey + domain in hand).

## What already exists (verified in code)

- Custom Accept/Reject banner: `src/components/CookieConsent.tsx`, mounted
  from `AppShell.tsx:2579`.
- Client consent store over the non-HttpOnly `lw_consent` cookie:
  `src/lib/consent-client.ts` (useConsent, readConsentCookie,
  setConsentClient, dispatchReopenBanner).
- Server source of truth: `POST /api/consent` (origin-gated) sets
  `lw_consent`, issues/clears `lw_anon`.
- Consent-gated analytics: `src/components/ConditionalAnalytics.tsx`
  (GA4 + Vercel Analytics + Speed Insights, render null unless "accepted").
- Reject clears `lw.saved.v1` / `lw.liked.v1` localStorage.
- Footer "Manage cookies" dispatches `lw:consent:reopen`.
- What is missing (per the 2026-06-22 council): documented consent records.
  CCM19 provides exactly that.

## Chosen approach: CCM19 as UI + record layer, bridged into lw_consent

CCM19's app.js loads `beforeInteractive` in the root layout head (the
Next.js 16 docs name cookie consent managers as the canonical use for that
strategy). CCM19 shows its banner and stores the consent record. A small
client bridge (`Ccm19Bridge.tsx`) maps CCM19 state into the existing
plumbing by calling `setConsentClient()` — so ConditionalAnalytics, the
engagement stores, anon-token issuance, and localStorage clearing all keep
working with zero changes.

Mapping (pure function `deriveConsentFromCcm` in `src/lib/ccm19.ts`):

- `CCM.consent` false/absent → null (undecided; never overwrite lw_consent)
- `CCM.fullConsentGiven` → "accepted"
- configured embedding name found in `CCM.acceptedEmbeddings`
  (case-insensitive) → "accepted"
- otherwise (consent saved, our purpose not accepted) → "rejected"

Bridge triggers: mount + `ccm19WidgetLoaded` + `ccm19WidgetClosed` +
`ccm19EmbeddingAccepted`. Only POSTs when the derived value differs from
the current cookie (idempotent, no request spam). `lw:consent:reopen`
(footer "Manage cookies") calls `CCM.openWidget()` when CCM19 is enabled.

Rollout switch: `NEXT_PUBLIC_CCM19_SRC` env var (the full snippet URL).
Unset → the existing custom banner keeps running unchanged (dev/preview
continuity, instant rollback by removing the env var). Set → CCM19 banner
+ bridge, custom banner not mounted.

Script-blocking integration type: none of CCM19's three blocking variants
is used for GA/Vercel because our own gate (lw_consent) already blocks
loading AND execution — equivalent to their strictest Type 3, but the
consent decision flows through CCM19 first. No script markup changes.

## CCM19 dashboard configuration (manual, Yoav)

1. Create ONE optional purpose/embedding named exactly
   "Analytics & device personalization" covering GA4, Vercel Analytics,
   Speed Insights, and saved/liked device storage. One purpose because
   lw_consent is binary; three separate toggles could not be represented.
2. Mark as essential/mandatory: `lw_session`, `lw_user`, `lw_consent`,
   `lw_vote`, `lw_oauth_*`, theme localStorage. `lw_anon` documented under
   the optional purpose (issued only on accept).
3. Set `NEXT_PUBLIC_CCM19_EMBEDDING="Analytics & device personalization"`
   so the bridge matches by name even if more purposes are added later.
4. Sentry stays out of CCM19 blocking (operational telemetry, existing
   intentional carve-out, sendDefaultPii: false).

## Alternatives considered and rejected

- **CCM19 Type 2 (tag-manager mode: paste GA scripts into CCM19 backend).**
  Simple, but moves script control out of the repo into a SaaS dashboard,
  bypasses ConditionalAnalytics' env-gating/logging/SPA pageview logic, and
  violates the "build it, don't rent it" ownership stance for behavior we
  already built. Rejected.
- **Rip out the custom consent plumbing, read window.CCM everywhere.**
  Touches every consumer (analytics, engagement store, stories prefs, anon
  token issuance), loses the synchronous cookie read that prevents banner
  flash, and couples the whole app to a third-party global. Rejected.
- **Keep the custom banner, skip CCM19.** No auditable consent records —
  the exact gap being closed. Overridden by the explicit user decision.

## Security (rule 13)

- app.js is third-party code with full DOM access, loaded from Yoav's
  white-label CCM19 host with `referrerpolicy="origin"` per vendor snippet.
  The apiKey in the URL is a public widget key by design, not a secret.
- No CSP configured in this app today (verified), so no allowlist change.
- Consent writes still go through the origin-gated POST /api/consent; the
  bridge never trusts CCM19 for anything but the accept/reject signal.
- Fail closed: adblocked/failed app.js → no CCM object → derived null →
  lw_consent stays unset → analytics never load.

## Observability (rule 14)

`[consent ccm19]` namespace: sync attempts (trigger, derived, current,
ccmPresent), sync failures, reopen calls, reopen-unavailable warning.
Existing `[auth ui consent set]` / `[analytics consent]` logs show the
downstream effects.

## Settings (rule 15)

- `NEXT_PUBLIC_CCM19_SRC` / `NEXT_PUBLIC_CCM19_EMBEDDING` env vars, not
  admin settings — matches the NEXT_PUBLIC_GA_MEASUREMENT_ID pattern, and
  a build-time layout script can't read settings_kv per-request. Consent
  choices themselves are user-facing via the CCM19 widget + footer link.

## Testing (rule 18)

- `src/lib/ccm19.test.ts`: every deriveConsentFromCcm branch.
- `src/components/Ccm19Bridge.test.tsx` (happy-dom): initial sync POSTs on
  full consent; no POST when undecided or cookie already matches; event
  dispatch triggers sync; reopen event calls CCM.openWidget.
- Full `vitest run` + eslint + tsc --noEmit must be green.
- Out of scope: exercising the real CCM19 widget (external SaaS UI).

## Deploy (rule 19)

- Work on `feat/gdpr-ccm19-consent` off fresh origin/main; PR into main;
  no push/merge without explicit approval.
- Ship dark: code merges with `NEXT_PUBLIC_CCM19_SRC` unset → nothing
  changes for users. Enabling = adding the env var in Vercel (Production)
  + configuring the CCM19 dashboard, then redeploy. Rollback = remove the
  env var (custom banner returns instantly).

## Open questions / follow-ups

- Cookie-policy + privacy-policy copy still describe the first-party
  banner; needs a wording pass once CCM19 goes live (legal-page track).
- Grandfathering: existing users (including prior accepts) see the CCM19
  banner once because CCM19 has no record for them; their new choice
  becomes the record. This is the GDPR-correct behavior; accepted.
- CCM19 subscription tier must cover the production domain (existing
  account; no new cost introduced by this change).
