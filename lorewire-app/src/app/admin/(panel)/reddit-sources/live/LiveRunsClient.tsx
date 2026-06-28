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

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  isJobActive,
  isJobFinished,
  type ActiveJobView,
} from "@/lib/story-jobs-live-shared";
import { listActiveJobsWithEventsAction } from "@/app/admin/actions";
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
  const cancelledRef = useRef(false);

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

    async function tick() {
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
    }

    function startTimer() {
      if (timer != null) return;
      timer = setInterval(() => {
        void tick();
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
    // initialJobs is only read once at mount for the log; hideFinished is
    // read here but the tick re-runs on every interval regardless of the
    // param, so the dep is stable enough for the lint rule's purposes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleJobs = hideFinished ? jobs.filter((j) => isJobActive(j)) : jobs;
  const activeCount = jobs.filter((j) => isJobActive(j)).length;
  const finishedCount = jobs.filter((j) => isJobFinished(j)).length;

  return (
    <div className="space-y-4">
      <StatusBar
        activeCount={activeCount}
        finishedCount={finishedCount}
        hideFinished={hideFinished}
        lastUpdate={lastUpdate}
        polling={polling}
        error={error}
      />

      {visibleJobs.length === 0 ? (
        <EmptyState hideFinished={hideFinished} />
      ) : (
        <ul className="space-y-3">
          {visibleJobs.map((job) => (
            <li key={job.job_id}>
              <LiveJobCard job={job} />
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
}: {
  activeCount: number;
  finishedCount: number;
  hideFinished: boolean;
  lastUpdate: number;
  polling: boolean;
  error: string | null;
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
      {error && (
        <span className="font-mono text-[11px] text-danger" role="status">
          poll error — retrying. {error}
        </span>
      )}
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
