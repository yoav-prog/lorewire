"use client";

// Polling client for /admin/reddit-sources/live — the unified runs board.
// Shows EVERY run kind, categorised: pipeline story jobs (full event
// cards), hero+thumbnail finishers, short renders, image renders, voice
// renders, and refresh-assets chains. Filter chips (kind + status), a
// search box, multi-select with Stop selected, per-run Stop, and the
// pipeline Stop all. Polls every 2 seconds while the tab is focused;
// paused when hidden, with an "updated X ago" indicator.
//
// The initial props are the SSR snapshot, so the first paint shows real
// data; the first poll happens 2 seconds after mount, not on mount.
//
// Plans: _plans/2026-06-28-reddit-sources-live-runs-page.md (pipeline
// cards) + _plans/2026-07-03-unified-live-runs-and-stop.md (all kinds,
// filters, search, multi-select stop).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  isJobActive,
  type ActiveJobView,
} from "@/lib/story-jobs-live-shared";
import type { UnifiedRun, UnifiedRunKind } from "@/lib/runs";
import {
  listAllRunsAction,
  stopAllActiveLiveRunsAction,
  stopLiveRunAction,
  stopUnifiedRunAction,
} from "@/app/admin/actions";
import LiveJobCard from "./LiveJobCard";

const POLL_MS = 2000;

// "pipeline" joins the unified kinds for filtering/selection purposes.
type KindFilter = "all" | "pipeline" | UnifiedRunKind;
type StatusFilter =
  | "all"
  | "active"
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled";

const KIND_ORDER: readonly Exclude<KindFilter, "all">[] = [
  "pipeline",
  "finisher",
  "short",
  "image",
  "voice",
  "refresh",
];

const KIND_LABELS: Record<Exclude<KindFilter, "all">, string> = {
  pipeline: "Pipeline",
  finisher: "Hero+thumb",
  short: "Shorts",
  image: "Images",
  voice: "Voice",
  refresh: "Refresh",
};

// Kind tints, explicit class strings so Tailwind's purge keeps them.
const KIND_BADGE_CLASS: Record<Exclude<KindFilter, "all">, string> = {
  pipeline: "border-accent/40 bg-accent/10 text-accent",
  finisher: "border-cat-entitled/40 bg-cat-entitled/10 text-cat-entitled",
  short: "border-high/40 bg-high/10 text-high",
  image: "border-cat-wholesome/40 bg-cat-wholesome/10 text-cat-wholesome",
  voice: "border-cat-dating/40 bg-cat-dating/10 text-cat-dating",
  refresh: "border-line bg-surface2 text-muted",
};

const STATUS_FILTERS: readonly StatusFilter[] = [
  "all",
  "active",
  "queued",
  "running",
  "done",
  "error",
  "cancelled",
];

/** Normalized status of a pipeline job for the shared status filter. */
function jobStatus(job: ActiveJobView): Exclude<StatusFilter, "all" | "active"> {
  if (job.status === "queued") return "queued";
  if (job.status === "processing") return "running";
  if (job.status === "error") return "error";
  if (job.status === "cancelled") return "cancelled";
  // 'done' story stage can still have a short/finisher in flight.
  return isJobActive(job) ? "running" : "done";
}

function matchesStatus(
  status: Exclude<StatusFilter, "all" | "active">,
  filter: StatusFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "active") return status === "queued" || status === "running";
  return status === filter;
}

function matchesQuery(hay: (string | null | undefined)[], q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return hay.some((h) => (h ?? "").toLowerCase().includes(needle));
}

/** Selection key: one namespace across both row shapes. */
function runKey(kind: Exclude<KindFilter, "all">, id: string): string {
  return `${kind}:${id}`;
}

function agoLabel(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export default function LiveRunsClient({
  initialJobs,
  initialRuns,
  hideFinished,
}: {
  initialJobs: ActiveJobView[];
  initialRuns: UnifiedRun[];
  hideFinished: boolean;
}) {
  const [jobs, setJobs] = useState<ActiveJobView[]>(initialJobs);
  const [runs, setRuns] = useState<UnifiedRun[]>(initialRuns);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(() => Date.now());
  const [polling, setPolling] = useState<boolean>(true);
  const [stoppingAll, setStoppingAll] = useState<boolean>(false);
  const [stoppingSelected, setStoppingSelected] = useState<boolean>(false);
  // Filters. The legacy ?finished=hide param maps onto the Active chip.
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    hideFinished ? "active" : "all",
  );
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const t0 = performance.now();
      const snapshot = await listAllRunsAction();
      if (cancelledRef.current) return;
      console.info("[live runs poll]", {
        job_count: snapshot.jobs.length,
        run_count: snapshot.runs.length,
        duration_ms: Math.round(performance.now() - t0),
      });
      setJobs(snapshot.jobs);
      setRuns(snapshot.runs);
      setError(null);
      setLastUpdate(Date.now());
    } catch (e) {
      if (cancelledRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[live runs poll error]", { err: msg });
      setError(msg);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    console.info("[live runs mount]", {
      initial_job_count: initialJobs.length,
      initial_run_count: initialRuns.length,
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
      if (document.visibilityState === "visible") startTimer();
      else stopTimer();
    }
    if (document.visibilityState === "visible") startTimer();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelledRef.current = true;
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // refresh is a stable useCallback so this effect runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // ── filtering ──────────────────────────────────────────────────────────
  const searchedJobs = useMemo(
    () =>
      jobs.filter(
        (j) =>
          matchesStatus(jobStatus(j), statusFilter) &&
          matchesQuery([j.title, j.reddit_id, j.story_id, j.subreddit], q),
      ),
    [jobs, statusFilter, q],
  );
  const searchedRuns = useMemo(
    () =>
      runs.filter(
        (r) =>
          matchesStatus(r.status, statusFilter) &&
          matchesQuery([r.storyTitle, r.storyId, r.label, r.id], q),
      ),
    [runs, statusFilter, q],
  );

  // Kind counts AFTER status+search so the chips describe what a click
  // will actually show.
  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = { pipeline: searchedJobs.length };
    for (const r of searchedRuns) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    return counts;
  }, [searchedJobs, searchedRuns]);

  const visibleJobs = useMemo(
    () =>
      kindFilter === "all" || kindFilter === "pipeline" ? searchedJobs : [],
    [kindFilter, searchedJobs],
  );
  const visibleRuns = searchedRuns.filter(
    (r) => kindFilter === "all" || kindFilter === r.kind,
  );

  // ── selection ──────────────────────────────────────────────────────────
  // Only stoppable rows are selectable: queued/running unified runs
  // (finishers only while still queued) and active pipeline jobs.
  const stoppableKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const j of visibleJobs) {
      if (isJobActive(j)) keys.add(runKey("pipeline", j.job_id));
    }
    for (const r of visibleRuns) {
      if (isRunStoppable(r)) keys.add(runKey(r.kind, r.id));
    }
    return keys;
  }, [visibleJobs, visibleRuns]);

  const selectedVisible = useMemo(
    () => [...selected].filter((k) => stoppableKeys.has(k)),
    [selected, stoppableKeys],
  );

  const toggleSelected = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) =>
      prev.size >= stoppableKeys.size && stoppableKeys.size > 0
        ? new Set()
        : new Set(stoppableKeys),
    );
  }, [stoppableKeys]);

  // ── stop handlers ──────────────────────────────────────────────────────
  const handleStopJob = useCallback(
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

  const handleStopRun = useCallback(
    async (kind: UnifiedRunKind, id: string) => {
      try {
        const r = await stopUnifiedRunAction(kind, id);
        if (!r.ok) setError("Stop failed.");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      await refresh();
    },
    [refresh],
  );

  const handleStopSelected = useCallback(async () => {
    const keys = selectedVisible;
    if (stoppingSelected || keys.length === 0) return;
    const ok = window.confirm(
      `Stop ${keys.length} selected run${keys.length === 1 ? "" : "s"}?\n\n` +
        "In-flight work settles as cancelled; spend already incurred is non-refundable.",
    );
    if (!ok) return;
    setStoppingSelected(true);
    let stopped = 0;
    try {
      // Sequential, same rationale as Stop all: a rare deliberate action
      // over a small set, and serial writes keep the logs readable.
      for (const key of keys) {
        const [kind, id] = key.split(/:(.+)/, 2) as [
          Exclude<KindFilter, "all">,
          string,
        ];
        if (kind === "pipeline") {
          const r = await stopLiveRunAction(id);
          if (r.ok) stopped += 1;
        } else {
          const r = await stopUnifiedRunAction(kind, id);
          if (r.ok && r.changed) stopped += 1;
        }
      }
      console.info("[live runs stop-selected]", {
        requested: keys.length,
        stopped,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStoppingSelected(false);
      setSelected(new Set());
    }
    await refresh();
  }, [selectedVisible, stoppingSelected, refresh]);

  const activePipelineCount = jobs.filter((j) => isJobActive(j)).length;
  const handleStopAll = useCallback(async () => {
    if (stoppingAll || activePipelineCount === 0) return;
    const ok = window.confirm(
      `Stop all ${activePipelineCount} active pipeline run${activePipelineCount === 1 ? "" : "s"}?\n\n` +
        "Every in-flight stage gets cancelled. Runs still in the story stage reset to 'imported'. Spend already incurred is non-refundable.",
    );
    if (!ok) return;
    setStoppingAll(true);
    try {
      const r = await stopAllActiveLiveRunsAction();
      console.info("[live runs stop-all]", r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStoppingAll(false);
    }
    await refresh();
  }, [activePipelineCount, stoppingAll, refresh]);

  const nothingVisible = visibleJobs.length === 0 && visibleRuns.length === 0;

  return (
    <div className="space-y-4">
      <StatusBar
        activeCount={
          activePipelineCount +
          runs.filter((r) => r.status === "queued" || r.status === "running")
            .length
        }
        lastUpdate={lastUpdate}
        polling={polling}
        error={error}
        selectedCount={selectedVisible.length}
        stoppableCount={stoppableKeys.size}
        onToggleSelectAll={toggleSelectAll}
        onStopSelected={handleStopSelected}
        stoppingSelected={stoppingSelected}
        onStopAll={handleStopAll}
        stopAllCount={activePipelineCount}
        stoppingAll={stoppingAll}
      />

      <FilterBar
        kindFilter={kindFilter}
        setKindFilter={setKindFilter}
        kindCounts={kindCounts}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        q={q}
        setQ={setQ}
      />

      {nothingVisible ? (
        <div className="rounded-xl border border-line bg-surface px-4 py-10 text-center">
          <p className="font-mono text-[12px] text-muted">
            {q || kindFilter !== "all" || statusFilter !== "all"
              ? "No runs match the current filters."
              : "No active runs and nothing settled in the last 15 minutes."}
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {visibleJobs.length > 0 && (
            <RunGroup label={KIND_LABELS.pipeline} count={visibleJobs.length}>
              <ul className="space-y-3">
                {visibleJobs.map((job) => (
                  <li key={job.job_id} className="flex items-start gap-2.5">
                    <SelectBox
                      disabled={!isJobActive(job)}
                      checked={selected.has(runKey("pipeline", job.job_id))}
                      onToggle={() =>
                        toggleSelected(runKey("pipeline", job.job_id))
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <LiveJobCard job={job} onStop={handleStopJob} />
                    </div>
                  </li>
                ))}
              </ul>
            </RunGroup>
          )}

          {KIND_ORDER.filter((k) => k !== "pipeline").map((kind) => {
            const group = visibleRuns.filter((r) => r.kind === kind);
            if (group.length === 0) return null;
            return (
              <RunGroup key={kind} label={KIND_LABELS[kind]} count={group.length}>
                <ul className="space-y-1.5">
                  {group.map((r) => (
                    <RunRow
                      key={runKey(r.kind, r.id)}
                      run={r}
                      selected={selected.has(runKey(r.kind, r.id))}
                      onToggle={() => toggleSelected(runKey(r.kind, r.id))}
                      onStop={() => handleStopRun(r.kind, r.id)}
                    />
                  ))}
                </ul>
              </RunGroup>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Finishers can only be stopped before a function claims them; refresh
 *  chains are always un-armable; queue rows while queued/running. */
function isRunStoppable(r: UnifiedRun): boolean {
  if (r.kind === "finisher") return r.status === "queued";
  if (r.kind === "refresh") return true;
  return r.status === "queued" || r.status === "running";
}

function SelectBox({
  checked,
  disabled,
  onToggle,
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onToggle}
      aria-label="Select run"
      className="mt-1 h-4 w-4 shrink-0 accent-accent disabled:opacity-30"
    />
  );
}

function RunGroup({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted">
        {label} <span className="text-ink">{count}</span>
      </h2>
      {children}
    </section>
  );
}

const RUN_STATUS_CLASS: Record<UnifiedRun["status"], string> = {
  queued: "border-high/40 bg-high/10 text-high",
  running: "border-accent/40 bg-accent/10 text-accent",
  done: "border-cat-wholesome/40 bg-cat-wholesome/10 text-cat-wholesome",
  error: "border-danger/40 bg-danger/10 text-danger",
  cancelled: "border-line bg-surface2 text-muted",
};

function RunRow({
  run,
  selected,
  onToggle,
  onStop,
}: {
  run: UnifiedRun;
  selected: boolean;
  onToggle: () => void;
  onStop: () => void | Promise<void>;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(handle);
  }, []);
  const stoppable = isRunStoppable(run);
  const when = run.finishedAt ?? run.startedAt ?? run.requestedAt;
  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2">
      <SelectBox
        checked={selected}
        disabled={!stoppable}
        onToggle={onToggle}
      />
      <span
        className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${KIND_BADGE_CLASS[run.kind]}`}
      >
        {KIND_LABELS[run.kind]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {run.storyId ? (
            <Link
              href={`/admin/stories/${run.storyId}`}
              className="truncate font-body text-[13px] font-semibold text-ink hover:underline"
            >
              {run.storyTitle ?? run.storyId}
            </Link>
          ) : (
            <span className="truncate font-body text-[13px] font-semibold text-ink">
              {run.storyTitle ?? run.id}
            </span>
          )}
          <span className="truncate font-mono text-[11px] text-muted">
            {run.label}
          </span>
        </div>
        {run.error && (
          <p className="mt-0.5 truncate font-mono text-[10px] text-danger">
            {run.error}
          </p>
        )}
      </div>
      {run.progress != null && run.status === "running" && (
        <span className="shrink-0 font-mono text-[11px] text-muted">
          {run.progress}%
        </span>
      )}
      <span className="shrink-0 font-mono text-[10px] text-muted">
        {agoLabel(when, now)}
      </span>
      <span
        className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${RUN_STATUS_CLASS[run.status]}`}
      >
        {run.status}
      </span>
      {stoppable && (
        <button
          type="button"
          onClick={() => void onStop()}
          className="shrink-0 rounded-md border border-danger/40 bg-danger/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-danger hover:opacity-80"
        >
          Stop
        </button>
      )}
    </li>
  );
}

function FilterBar({
  kindFilter,
  setKindFilter,
  kindCounts,
  statusFilter,
  setStatusFilter,
  q,
  setQ,
}: {
  kindFilter: KindFilter;
  setKindFilter: (k: KindFilter) => void;
  kindCounts: Record<string, number>;
  statusFilter: StatusFilter;
  setStatusFilter: (s: StatusFilter) => void;
  q: string;
  setQ: (q: string) => void;
}) {
  const totalCount = Object.values(kindCounts).reduce((a, b) => a + b, 0);
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface px-3 py-2.5">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search title, story id, asset, run id…"
        className="w-full rounded-lg border border-line bg-bg px-3 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-muted focus:border-accent"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip
          active={kindFilter === "all"}
          onClick={() => setKindFilter("all")}
          label={`All ${totalCount}`}
        />
        {KIND_ORDER.map((k) => (
          <FilterChip
            key={k}
            active={kindFilter === k}
            onClick={() => setKindFilter(k)}
            label={`${KIND_LABELS[k]} ${kindCounts[k] ?? 0}`}
          />
        ))}
        <span aria-hidden className="mx-1 h-4 w-px bg-line" />
        {STATUS_FILTERS.map((s) => (
          <FilterChip
            key={s}
            active={statusFilter === s}
            onClick={() => setStatusFilter(s)}
            label={s}
          />
        ))}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors ${
        active
          ? "border-accent bg-accent/15 text-ink"
          : "border-line bg-bg text-muted hover:border-ink hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}

function StatusBar({
  activeCount,
  lastUpdate,
  polling,
  error,
  selectedCount,
  stoppableCount,
  onToggleSelectAll,
  onStopSelected,
  stoppingSelected,
  onStopAll,
  stopAllCount,
  stoppingAll,
}: {
  activeCount: number;
  lastUpdate: number;
  polling: boolean;
  error: string | null;
  selectedCount: number;
  stoppableCount: number;
  onToggleSelectAll: () => void;
  onStopSelected: () => void | Promise<void>;
  stoppingSelected: boolean;
  onStopAll: () => void | Promise<void>;
  stopAllCount: number;
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
        <span>updated {ageSec}s ago</span>
        {stoppableCount > 0 && (
          <button
            type="button"
            onClick={onToggleSelectAll}
            className="text-accent hover:underline"
          >
            {selectedCount >= stoppableCount
              ? "Clear selection"
              : `Select all ${stoppableCount} stoppable`}
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        {error && (
          <span className="font-mono text-[11px] text-danger" role="status">
            poll error, retrying. {error}
          </span>
        )}
        {selectedCount > 0 && (
          <button
            type="button"
            onClick={() => void onStopSelected()}
            disabled={stoppingSelected}
            className="rounded-md border border-danger/40 bg-danger/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-danger hover:opacity-80 disabled:opacity-50"
          >
            {stoppingSelected
              ? "Stopping…"
              : `Stop selected ${selectedCount}`}
          </button>
        )}
        {stopAllCount > 0 && (
          <button
            type="button"
            onClick={() => void onStopAll()}
            disabled={stoppingAll}
            title="Cancel every active pipeline run."
            className="rounded-md border border-danger/40 bg-danger/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-danger hover:opacity-80 disabled:opacity-50"
          >
            {stoppingAll ? "Stopping…" : `Stop all pipeline ${stopAllCount}`}
          </button>
        )}
      </div>
    </div>
  );
}
