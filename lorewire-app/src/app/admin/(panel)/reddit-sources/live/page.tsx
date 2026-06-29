// Live runs aggregator. Every in-flight story_jobs row (queued /
// processing) plus jobs finished within the last 15 minutes, each with
// its event log streaming live. Polls every 2 seconds.
//
// Server component scope: capability gate + initial snapshot for
// no-flash first paint, then hand off to LiveRunsClient. The client
// owns the polling loop, the URL-param logic, and the empty/populated
// branches. The action this page renders against is content.manage-
// gated; the page wraps the same gate around the SSR fetch.
//
// Plan: _plans/2026-06-28-reddit-sources-live-runs-page.md.

import Link from "next/link";
import { requireCapability } from "@/lib/dal";
import { listActiveJobsWithEvents } from "@/lib/story-jobs-live";
import LiveRunsClient from "./LiveRunsClient";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ finished?: string }>;
}

export default async function LiveRunsPage({ searchParams }: PageProps) {
  await requireCapability("content.manage");
  const sp = await searchParams;
  const hideFinished = sp.finished === "hide";

  // SSR snapshot so the page paints with real data on first load instead
  // of an empty shell that fills in 2 seconds later. The client picks up
  // from here and polls.
  const initialJobs = await listActiveJobsWithEvents();

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/admin/reddit-sources"
          className="font-mono text-[12px] text-muted hover:text-ink"
        >
          &larr; Reddit Sources
        </Link>
        <span className="font-mono text-[11px] text-muted">
          {hideFinished ? "active only" : "active + recently finished"}
        </span>
      </div>

      <header className="space-y-1">
        <h1 className="font-display text-[20px] font-extrabold leading-tight tracking-tightest text-ink">
          Live runs
        </h1>
        <p className="font-mono text-[11px] text-muted">
          Every queued or processing story job, plus jobs finished in the
          last 15 minutes, with their event log streaming live. Poll
          cadence is 2 seconds while this tab is focused.
        </p>
      </header>

      <LiveRunsClient initialJobs={initialJobs} hideFinished={hideFinished} />
    </div>
  );
}
