"use client";

// Polling client for /admin/reddit-sources/live. Renders one card per
// active job, paused when the tab is hidden, with a tiny "updated X
// ago" indicator so the admin can tell at a glance whether the page is
// alive. URL-param toggle ?finished=hide drops the recently-finished
// grace-window cards.
//
// The initialJobs prop is the SSR snapshot, so the first paint shows
// real data; the first poll happens 2 seconds after mount, not on
// mount, to avoid double-fetching the same data the server just sent.
//
// Plan: _plans/2026-06-28-reddit-sources-live-runs-page.md.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  isJobActive,
  isJobFinished,
  type ActiveJobView,
} from "@/lib/story-jobs-live-shared";
import {
  listActiveJobsWithEventsAction,
  stopAllActiveLiveRunsAction,
  stopLiveRunAction,
} from "@/app/admin/actions";
import LiveJobCard from "./LiveJobCard";

const POLL_MS = 2000;

export default function LiveRunsClient({
  initialJobs,
  hideFinished,
}: {
  initialJobs: ActiveJobView[];
  hideFinished: boolean;
}) {
  const [jobs, setJobs] = useState<ActiveJobView[]>(initialJobs);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(() => Date.now());
  const [polling, setPolling] = useState<boolean>(true);
  const [stoppingAll, setStoppingAll] = useState<boolean>(false);
  const cancelledRef = useRef(false);

  // One fetch, shared by the poll loop and the manual refresh-after-stop
  // path so a Stop reflects immediately instead of waiting up to POLL_MS.
  // Stable (no deps) so the mount effect runs exactly once.
  const refresh = useCallback(async () => {
    try {
      const t0 = performance.now();
      const rows = await listActiveJobsWithEventsAction();
      if (cancelledRef.current) return;
      const durationMs = Math.round(performance.now() - t0);
      const eventCount = rows.reduce((acc, j) => acc + j.events.length, 0);
      console.info("[reddit-sources live poll]", {
        job_count: rows.length,
        event_count: eventCount,
        duration_ms: durationMs,
      });
      setJobs(rows);
      setError(null);
      setLastUpdate(Date.now());
    } catch (e) {
      if (cancelledRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[reddit-sources live poll error]", { err: msg });
      setError(msg);
    }
  }, []);

  // Mount log + visibility-driven start/stop loop. The "first tick fires
  // POLL_MS after mount" shape means the SSR snapshot drives the initial
  // paint and we don't refetch immediately — saves one round trip.
  useEffect(() => {
    cancelledRef.current = false;
    console.info("[reddit-sources live mount]", {
      initial_job_count: initialJobs.length,
      hide_finished: hideFinished,
    });

    let timer: ReturnType<typeof setInterval> | null = null;

    function startTimer() {
      if (timer != null) return;
      timer = setInterval(() => {
        void refresh();
      }, POLL_MS);
      setPolling(true);
    }
    function stopTimer() {
      if (timer == null) return;
      clearInterval(timer);
      timer = null;
      setPolling(false);
    }

    function onVisibility() {
      const visible = document.visibilityState === "visible";
      console.info("[reddit-sources live visibility]", { visible });
      if (visible) startTimer();
      else stopTimer();
    }

    if (document.visibilityState === "visible") startTimer();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelledRef.current = true;
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // initialJobs/hideFinished are read here only for the mount log;
    // refresh is a stable useCallback so this effect runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // Per-run Stop: fire the action, surface any error, then refetch so the
  // card settles (or drops) without waiting for the next poll tick.
  const handleStopRun = useCallback(
    async (jobId: string) => {
      try {
        const r = await stopLiveRunAction(jobId);
        if (!r.ok) setError(r.error ?? "Stop failed.");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      await refresh();
    },
    [refresh],
  );

  const activeJobs = jobs.filter((j) => isJobActive(j));
  const activeCount = activeJobs.length;
  const finishedCount = jobs.filter((j) => isJobFinished(j)).length;
  const visibleJobs = hideFinished ? activeJobs : jobs;

  const handleStopAll = useCallback(async () => {
    if (stoppingAll || activeCount === 0) return;
    const ok = window.confirm(
      `Stop all ${activeCount} active run${activeCount === 1 ? "" : "s"}?\n\n` +
        "Every in-flight stage gets cancelled so they all drop off the live list.\n\n" +
        "Finished articles are kept. Runs still in the story stage reset to 'imported'. Any spend already incurred is non-refundable.",
    );
    if (!ok) return;
    setStoppingAll(true);
    try {
      const r = await stopAllActiveLiveRunsAction();
      console.info("[reddit-sources live stop-all]", r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStoppingAll(false);
    }
    await refresh();
  }, [activeCount, stoppingAll, refresh]);

  return (
    <div className="space-y-4">
      <StatusBar
        activeCount={activeCount}
        finishedCount={finishedCount}
        hideFinished={hideFinished}
        lastUpdate={lastUpdate}
        polling={polling}
        error={error}
        onStopAll={handleStopAll}
        stoppingAll={stoppingAll}
      />

      {visibleJobs.length === 0 ? (
        <EmptyState hideFinished={hideFinished} />
      ) : (
        <ul className="space-y-3">
          {visibleJobs.map((job) => (
            <li key={job.job_id}>
              <LiveJobCard job={job} onStop={handleStopRun} />
            </li>
          ))}
        </ul>
      )}

      <TipFooter hideFinished={hideFinished} />
    </div>
  );
}

function StatusBar({
  activeCount,
  finishedCount,
  hideFinished,
  lastUpdate,
  polling,
  error,
  onStopAll,
  stoppingAll,
}: {
  activeCount: number;
  finishedCount: number;
  hideFinished: boolean;
  lastUpdate: number;
  polling: boolean;
  error: string | null;
  onStopAll: () => void | Promise<void>;
  stoppingAll: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, []);
  const ageSec = Math.max(0, Math.floor((now - lastUpdate) / 1000));

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2">
      <div className="flex items-center gap-3 font-mono text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          {polling ? (
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
            />
          ) : (
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-muted/40"
            />
          )}
          {polling ? "Live" : "Paused (tab hidden)"}
        </span>
        <span className="text-ink">
          <strong>{activeCount}</strong> active
        </span>
        {!hideFinished && (
          <span className="text-ink">
            <strong>{finishedCount}</strong> recently finished
          </span>
        )}
        <span>updated {ageSec}s ago</span>
      </div>
      <div className="flex items-center gap-3">
        {error && (
          <span className="font-mono text-[11px] text-danger" role="status">
            poll error, retrying. {error}
          </span>
        )}
        {activeCount > 0 && (
          <button
            type="button"
            onClick={onStopAll}
            disabled={stoppingAll}
            title="Cancel every active run."
            className="rounded-md border border-danger/40 bg-danger/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-danger hover:opacity-80 disabled:opacity-50"
          >
            {stoppingAll ? "Stopping…" : `Stop all ${activeCount}`}
          </button>
        )}
      </div>
    </div>
  );
}

function EmptyState({ hideFinished }: { hideFinished: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-10 text-center">
      <p className="font-mono text-[12px] text-muted">
        {hideFinished
          ? "No active runs right now."
          : "No active runs and nothing finished in the last 15 minutes."}
      </p>
      <Link
        href="/admin/reddit-sources"
        className="mt-3 inline-block font-mono text-[12px] text-accent hover:underline"
      >
        Open the Reddit Sources list →
      </Link>
    </div>
  );
}

function TipFooter({ hideFinished }: { hideFinished: boolean }) {
  return (
    <p className="font-mono text-[10px] text-muted">
      Tip:{" "}
      {hideFinished ? (
        <>
          showing active runs only. Append{" "}
          <Link
            href="/admin/reddit-sources/live"
            className="text-accent hover:underline"
          >
            ?finished=show
          </Link>{" "}
          (or just remove the param) to see jobs that finished in the last
          15 minutes too.
        </>
      ) : (
        <>
          finished jobs hang around for 15 minutes after they settle. Append{" "}
          <Link
            href="/admin/reddit-sources/live?finished=hide"
            className="text-accent hover:underline"
          >
            ?finished=hide
          </Link>{" "}
          to hide them.
        </>
      )}
    </p>
  );
}
