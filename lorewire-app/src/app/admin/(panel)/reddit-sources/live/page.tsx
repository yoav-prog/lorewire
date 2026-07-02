// Live runs aggregator — every run kind across the system, categorised:
// pipeline story jobs (with their event logs streaming live), the
// hero+thumbnail finishers, short renders, image renders, voice renders,
// and refresh-assets chains. Active runs plus anything settled within the
// last 15 minutes. Polls every 2 seconds.
//
// Server component scope: capability gate + initial snapshot for
// no-flash first paint, then hand off to LiveRunsClient. The client
// owns the polling loop, the kind/status/search filters, multi-select
// stop, and the empty/populated branches.
//
// Plans: _plans/2026-06-28-reddit-sources-live-runs-page.md +
// _plans/2026-07-03-unified-live-runs-and-stop.md.

import Link from "next/link";
import { requireCapability } from "@/lib/dal";
import { listActiveJobsWithEvents } from "@/lib/story-jobs-live";
import { listUnifiedRuns } from "@/lib/runs";
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
  const [initialJobs, initialRuns] = await Promise.all([
    listActiveJobsWithEvents(),
    listUnifiedRuns(),
  ]);

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
          Every run across the system — pipeline jobs, hero+thumbnail
          finishers, shorts, images, voice, refresh chains — active plus
          anything settled in the last 15 minutes. Filter by kind or
          status, search by title / id / asset, select runs to stop them.
          Poll cadence is 2 seconds while this tab is focused.
        </p>
      </header>

      <LiveRunsClient
        initialJobs={initialJobs}
        initialRuns={initialRuns}
        hideFinished={hideFinished}
      />
    </div>
  );
}
