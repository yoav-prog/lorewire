// Client-side instrumentation. Next.js loads this file in the browser
// before app code runs, so Sentry's init catches errors from the first
// render onward.
//
// Gated on NEXT_PUBLIC_SENTRY_DSN being set at build time. With no DSN,
// Sentry is silently disabled — same model as the server-side
// instrumentation.
//
// Privacy choices match the server side:
//   - sendDefaultPii: false (no IP, no user agent)
//   - No Sentry.setUser() calls anywhere in the app
//   - No replay sessions
//
// Note: we intentionally do NOT gate Sentry on cookie consent the way GA4
// is. Error tracking is operational telemetry, not user analytics; the
// captured payload contains stack traces and breadcrumbs, not identifiers.
// The user-facing Privacy Policy §3 discloses this distinction.

import * as Sentry from "@sentry/nextjs";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    sendDefaultPii: false,
    tracesSampleRate: 0.1,
    environment:
      process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
  });
  console.info("[sentry instrumentation-client] init", { release_set: !!process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA });
} else {
  console.info("[sentry instrumentation-client] skipped", {
    reason: "no NEXT_PUBLIC_SENTRY_DSN env var",
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
