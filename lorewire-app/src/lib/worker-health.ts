// Local-worker liveness for the admin UI.
//
// The Python worker (pipeline/story_jobs_worker.py:run_loop) writes a UTC
// ISO timestamp to `pipeline.story_jobs.worker_heartbeat_at` on every
// poll tick. This module reads that timestamp and tells the admin UI
// whether the worker is alive — gating the default of the with_media
// toggle on /admin/reddit-sources and surfacing a status pill on the
// budget bar.
//
// Why this matters: the Vercel cron drain pre-skips `with_media=True`
// jobs (Remotion can't run on Vercel's Python runtime). Full-media
// stories only complete on a local worker. Without this signal, the
// admin enqueues full-media jobs and discovers minutes later that the
// hosted drain failed every one — an expensive, frustrating loop. With
// this signal the admin sees "local worker offline" the moment they
// look at the page and the with_media default flips to "text only"
// automatically.

import "server-only";

import { getSetting } from "@/lib/repo";

export const WORKER_HEARTBEAT_SETTING_KEY =
  "pipeline.story_jobs.worker_heartbeat_at";

// 60 seconds: matches the worker-side comment. A tick that's mid-render
// won't write the heartbeat until it returns to the top of the loop, and
// we'd rather "healthy" than scare the admin into thinking the worker
// died during a long-running render. The pill flips amber after this
// window and red only when there's no heartbeat at all.
export const WORKER_HEARTBEAT_STALE_MS = 60_000;

export interface WorkerHealth {
  /** Last heartbeat timestamp, ISO-8601 UTC. null when never seen. */
  lastSeenAt: string | null;
  /** Seconds since the last heartbeat. null when lastSeenAt is null. */
  secondsSince: number | null;
  /** True when the heartbeat is fresher than WORKER_HEARTBEAT_STALE_MS. */
  isHealthy: boolean;
  /** Status bucket the UI uses to pick a colour:
   *   - "online":  fresh heartbeat
   *   - "stale":   heartbeat exists but older than STALE_MS
   *   - "offline": no heartbeat at all (never started, or DB just reset)
   */
  state: "online" | "stale" | "offline";
}

export async function getWorkerHealth(): Promise<WorkerHealth> {
  const raw = await getSetting(WORKER_HEARTBEAT_SETTING_KEY);
  if (!raw) {
    return {
      lastSeenAt: null,
      secondsSince: null,
      isHealthy: false,
      state: "offline",
    };
  }
  const lastMs = Date.parse(raw);
  if (!Number.isFinite(lastMs)) {
    console.warn("[worker-health] corrupt heartbeat value", { raw });
    return {
      lastSeenAt: raw,
      secondsSince: null,
      isHealthy: false,
      state: "offline",
    };
  }
  const ageMs = Date.now() - lastMs;
  const secondsSince = Math.max(0, Math.round(ageMs / 1000));
  const isHealthy = ageMs < WORKER_HEARTBEAT_STALE_MS;
  return {
    lastSeenAt: raw,
    secondsSince,
    isHealthy,
    state: isHealthy ? "online" : "stale",
  };
}
