// Server + edge runtime instrumentation. Next.js calls register() once per
// process when the runtime boots, before any request is served. We use it
// to wire Sentry into the Node.js and Edge runtimes when SENTRY_DSN is
// set. With no DSN, Sentry is silently disabled — useful for local dev,
// CI, and previews that don't need error reporting.
//
// Why both runtimes: server-rendered pages and most API routes run under
// the Node.js runtime; route handlers tagged `export const runtime = "edge"`
// run under the Edge runtime. Each needs its own Sentry init.
//
// PII is OFF by default: no IP capture, no user agent capture. We never
// call Sentry.setUser() anywhere, so events stay non-identifiable.

import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (!process.env.SENTRY_DSN) {
    console.info("[sentry instrumentation] skipped", {
      runtime: process.env.NEXT_RUNTIME,
      reason: "no SENTRY_DSN env var",
    });
    return;
  }

  const commonConfig = {
    dsn: process.env.SENTRY_DSN,
    sendDefaultPii: false,
    tracesSampleRate: 0.1,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
  } as const;

  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init(commonConfig);
    console.info("[sentry instrumentation] init", { runtime: "nodejs" });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init(commonConfig);
    console.info("[sentry instrumentation] init", { runtime: "edge" });
  }
}

export const onRequestError = Sentry.captureRequestError;
