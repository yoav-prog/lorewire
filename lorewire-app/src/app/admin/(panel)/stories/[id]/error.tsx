"use client";

// Route-segment error boundary for /admin/stories/[id]. Catches any
// throw during the SSR of this page (or any of its descendants) so the
// user sees a useful card instead of Next.js's generic "This page
// couldn't load" splash.
//
// Production builds mask the error MESSAGE for security, but the DIGEST
// is exposed — paste that digest into Vercel function logs (or send it
// here) to match the actual stack trace.
//
// Plan: _plans/2026-06-25-story-action-bar-and-rail-restructure.md
// (hot fix tail — the original throw site is still being debugged).

import { useEffect } from "react";

export default function StoryPageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console -- rule 14: surface the boundary catch
    console.error("[story page error boundary]", {
      message: error.message,
      digest: error.digest,
      stack: error.stack,
    });
  }, [error]);

  return (
    <div className="space-y-4 p-6">
      <div
        role="alert"
        className="rounded-xl border border-warn bg-warn/10 p-5"
      >
        <h2 className="mb-2 font-display text-lg font-semibold text-warn">
          Story editor failed to render
        </h2>
        <p className="mb-3 text-[13px] text-ink">
          A server-side error was thrown while loading this tab. Use the
          digest below to look up the exact stack trace in Vercel function
          logs.
        </p>
        <dl className="space-y-2 font-mono text-[12px]">
          <div>
            <dt className="text-muted">Digest:</dt>
            <dd className="select-all break-all rounded bg-bg/60 px-2 py-1 text-ink">
              {error.digest ?? "(no digest — likely a client-side throw)"}
            </dd>
          </div>
          {error.message && (
            <div>
              <dt className="text-muted">Message:</dt>
              <dd className="select-all break-all rounded bg-bg/60 px-2 py-1 text-ink">
                {error.message}
              </dd>
            </div>
          )}
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent"
          >
            Try again
          </button>
          <a
            href="/admin/content"
            className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:border-accent hover:text-accent"
          >
            Back to inbox
          </a>
        </div>
      </div>
    </div>
  );
}
