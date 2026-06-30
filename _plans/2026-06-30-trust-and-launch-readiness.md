# Trust surface + launch readiness

**Date:** 2026-06-30
**Author:** Yoav + Claude
**Branch:** `feat/trust-launch-readiness`
**Status:** In progress

## Why this exists

Amit (manager) reviewed the site and flagged five things on Lorewire:

1. Homepage shows only "Haven't Voted" and "Top 10" — no categories, no "MOST DEBATES" rail.
2. No Google Analytics.
3. No GDPR consent plumbing visible.
4. No trust / legal pages beyond Privacy + Terms (he used the Netflix footer as **structural** inspiration, not a literal copy).
5. No advertising routine.

Diagnostic verdicts (from three parallel audits, 2026-06-30):

| Topic | Reality |
|---|---|
| Homepage rails | All 8 rails exist. Two **safety features** stack to hide most of them on a thin catalog: daily category rotation (collapses 6 category rails to 1) + cold-start floor of 4 (hides any rail with <4 items). The divisive rail ("Most Debates") additionally needs 4+ stories with ≥20 votes each. **This is a settings + content problem, not a code problem.** |
| Google Analytics | Confirmed: nothing wired. Clean slate. |
| Cookie consent | Real and working. In-house banner + `/api/consent` route. Engagement store correctly gates writes on `consentAccepted()`. The "Manage cookies" footer reopener exists in code (`dispatchReopenBanner` + `lw:consent:reopen` custom event) but isn't wired into the footer yet. |
| Privacy / Terms | Real, specific, platform-review ready. Three TODOs are blockers for any platform submission: `CONTACT_EMAIL` is `info@lorewire.com` (wrong domain), `LEGAL_ENTITY` says "Flexelent (operator of LoreWire)" (Yoav confirmed Flexelent is NOT the operator), and `GOVERNING_LAW` is "the State of Israel" (TODO unconfirmed). |
| Trust pages | Only `/privacy` and `/terms` exist. Missing: Contact, FAQ, About, Cookie Policy, Community Guidelines, Accessibility, DMCA. |
| SEO surface | Excellent. Robots, dynamic sitemap, per-page OG/Twitter/JSON-LD, Phase 3 OG poster stamping, PWA manifest, Google + Bing verification metas. Not a blocker. |
| Error tracking | None (no Sentry / Bugsnag / Datadog). Production errors are silent. |
| Observability | Strong namespaced client logs (444 `console.info('[ns step]', {...})` call sites). Server side missing centralized error sink. |

## Constraints

- **Not targeting Israeli users right now.** Drops Hebrew legal pages and the IS 5568 mandatory accessibility version. Light accessibility statement still ships for AdSense + general standard.
- **Email is `contact@lorewire.com`.** Domain assumed live or about to be.
- **Operator is "LoreWire"**, not Flexelent. Flexelent reference was a stale code TODO author guess, not Yoav's instruction.
- **Governing law: defaulting to "the State of Israel"** (where Yoav operates from). This is the legal jurisdiction for disputes, not user targeting. Flagged for confirmation.
- **Next.js 16.2.9 + React 19.2.4.** Different conventions from older Next; match what existing pages do.
- **Production deploys via Vercel from a branch that may or may not be `main` right now.** Per AGENTS.md: verify production-source branch state before any push or merge. Do not click "Promote to Production" on any Vercel preview from this branch.

## Approach (chosen)

Single PR off `main`, scoped to trust + launch readiness only, in this order:

1. **Fix Privacy/Terms TODOs.** Three constants per file (1 email, 1 operator, 1 governing law for Terms). 10 minutes.
2. **Build 7 trust pages** matching the existing Privacy/Terms voice (plain, specific, no boilerplate): Contact, FAQ, About, Cookie Policy, Community Guidelines, Accessibility, DMCA.
3. **Redesign footer** to a 4-column layout (Help, Legal, Company, Connect+Cookies) with the Manage Cookies reopener wired via `dispatchReopenBanner()`.
4. **Wire GA4 + Vercel Analytics + Speed Insights** in a single `ConditionalAnalytics` component gated on `consent === "accepted"`. Reads `NEXT_PUBLIC_GA_MEASUREMENT_ID` from env.
5. **Wire Sentry** for server + client errors with `sendDefaultPii: false`. Reads `SENTRY_DSN` from env. Disabled when DSN is empty.
6. **Tests** for each new page (smoke render + metadata) and for the consent-gated analytics (consent denied → no GA scripts in DOM; consent accepted → scripts mount).
7. **Build verify + typecheck.**
8. **Stop before push.** Per rule 19, confirm with Yoav: (a) which branch Vercel Production tracks today, (b) whether this branch should PR into main or sit aside, (c) acceptable preview URL.

Homepage rail visibility is intentionally **NOT in this PR** — it's a settings toggle + content problem, handled separately via admin UI (Settings → Homepage → toggle off `rotating_category_enabled` and `cold_start_floor`).

## Alternatives rejected

- **Use a paid CMP (OneTrust / Cookiebot / Iubenda).** Rejected. The in-house consent system already works and respects user choice across the engagement store. A paid CMP costs $10–50/mo for marginal gain. Memory rule "Build it, don't rent it" applies.
- **Generate Privacy / Terms from Termly or similar generator.** Rejected. Current pages are specific and platform-review ready; replacing them would lose the YouTube/Meta/TikTok detail platforms look for. Better to keep them and fix the three TODOs.
- **Skip Sentry, rely on Vercel logs.** Rejected. Vercel logs are good for build/function debugging but lack stack traces, breadcrumbs, and release tagging. Sentry free tier (5k errors / month, $26/mo above) is the standard. Env-gated so it can be removed cheaply if needed.
- **Use PostHog instead of GA4.** Considered. PostHog is more flexible and self-hostable, but for "get Google AdSense approved" + "see basic pageviews" GA4 is the path of least resistance. Manager asked for Google Analytics specifically.
- **Build per-page contact forms instead of one Contact page.** Rejected. A single Contact page with `mailto:contact@lorewire.com` is the minimum that satisfies platform reviewers. Form-with-backend can come later.

## Security

- **Privacy policy honesty:** the moment GA4 lands, the existing line in Privacy §3 that says "no Google Analytics tracking script" becomes a lie. Updated to disclose GA4 + Vercel Analytics + Sentry, gated on consent.
- **Sentry PII:** `sendDefaultPii: false`. No IP, no user agent capture. No `setUser()` calls anywhere. Stack traces only.
- **GA4 IP anonymization:** `anonymize_ip: true` in gtag config. No remarketing, no Google Signals.
- **CSP:** verify nothing breaks with the new external scripts (googletagmanager.com, vercel.live). May need a `next.config.ts` update — flag if it breaks build.
- **Consent gating is enforced client-side AND server-side:** the GA4 script literally does not render unless `lw_consent === "accepted"`. The Vercel `<Analytics />` and `<SpeedInsights />` components are gated the same way. The consent flag is read every render, so a reject mid-session immediately stops new pageviews.
- **DMCA contact:** dedicated `dmca@lorewire.com` would be ideal. Falling back to `contact@lorewire.com` until then.

## Observability (rule 14)

Every new page logs on first render:
```
console.info('[trust page] mount', { route, lang })
```

The consent-gated analytics emits:
```
console.info('[analytics consent] state', { consent, ga: bool, vercel: bool })
console.info('[analytics consent] mount', { provider })
console.info('[analytics consent] unmount', { provider, reason })
```

The footer Manage Cookies reopener emits:
```
console.info('[footer manage-cookies] reopen-dispatch', { source: 'footer' })
```

Sentry tagged with `release: ${process.env.VERCEL_GIT_COMMIT_SHA}` and `environment: production|preview|development`.

## Settings (rule 15)

This work adds **no new user settings**. The cookie banner already handles consent. The accessibility statement and other static pages don't need toggles. The GA / Sentry / Vercel Analytics keys are env vars in Vercel, not user settings. Intentionally minimal.

Flagged for a later pass: admin-side toggle for "show Vercel Analytics" vs "GA only" vs "both," if Yoav wants to A/B the two. Out of scope for this PR.

## Testing (rule 18)

| Surface | Test |
|---|---|
| `/contact`, `/faq`, `/about`, `/cookie-policy`, `/community-guidelines`, `/accessibility`, `/dmca` | Renders without throwing; exports correct `<title>` and `description` metadata; contains the brand wordmark; uses the shared `<Section>` pattern |
| Footer | Renders all 4 columns; Manage Cookies button fires `dispatchReopenBanner()` (event listener called) |
| `ConditionalAnalytics` | Renders null when consent === "rejected"; renders GA + Vercel children when consent === "accepted"; updates when consent changes mid-session |
| Privacy / Terms | After edit: contains "contact@lorewire.com", does NOT contain "Flexelent", does NOT contain "info@lorewire.com" |

Vitest 4 already in `devDependencies`. Tests live next to the file under test (existing pattern).

## Deploy (rule 19)

- **Currently on:** `feat/trust-launch-readiness`, cut off `main` at the latest origin/main, in a clean working tree.
- **Will NOT touch:** `main`, any other feature branch, the Vercel Production Branch setting, any env vars in Vercel dashboard.
- **Will NOT click:** "Promote to Production", "Redeploy", or "Rebuild" on any Vercel preview built from this branch.
- **Before push:** verify Vercel Environments → Production tracks which branch (main, or a feature branch in the inverted state per AGENTS.md). If main, push is safe — opens a PR. If a feature branch, this PR's preview must NOT be promoted.
- **Before merge:** verify main is not behind the production-source branch. If main is behind production, refuse merge per AGENTS.md.
- **Rollback:** revert the merge commit; static pages and gated analytics are zero-impact when removed.

## Open questions for Yoav

1. **Governing law:** keep "the State of Israel" (current default — where you operate from), or change?
2. **Email addresses:** is `contact@lorewire.com` live as a real mailbox today, or do we need `info@flexelent.com` as a fallback until it's set up?
3. **GA4 measurement ID:** do you have one, or do I leave the env var unset and the component renders null until you add it?
4. **Sentry DSN:** same question — set up a Sentry project, or leave the env var unset for now?
5. **Vercel Production Branch:** is it `main` today, or still inverted to a feature branch?

## Out of scope (next PR)

- Homepage rail visibility (admin Settings toggle, not code)
- Advertising routine (cadence, posting cron, content calendar)
- Server-side error tracking beyond Sentry (datadog, axiom)
- A/B testing GA vs PostHog
- Hebrew localization (deferred since no Israeli targeting)
