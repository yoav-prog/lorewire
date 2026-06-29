"use client";

// One card per active or recently-finished story job. Pipeline-aware as
// of 2026-06-28 — the card shows the overall state plus a per-stage
// pill row (STORY · SHORT · HERO · PUBLISH) so the admin can see at a
// glance which stage is the bottleneck. Collapsed body shows the
// latest event line; expanded body shows the full event log with
// elapsed-from-start times.
//
// PUBLISH stage is hidden when it's `skipped` (the common case where
// the source isn't full_pipeline=1). That keeps the row from carrying
// a constantly-greyed pill that adds noise without information.
//
// Plans:
//   _plans/2026-06-28-live-runs-multistage-pipeline.md (this scope)
//   _plans/2026-06-28-reddit-sources-live-runs-page.md (PR #129)

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  isJobActive,
  isJobStuck,
  jobElapsedMs,
  type ActiveJobView,
  type PipelineOverallState,
  type PipelineStage,
  type PipelineStageState,
} from "@/lib/story-jobs-live-shared";

const OVERALL_TONE: Record<PipelineOverallState, string> = {
  queued: "border-accent/40 bg-accent/10 text-accent",
  running: "border-accent/40 bg-accent/15 text-accent",
  done: "border-cat-ok/40 bg-cat-ok/10 text-cat-ok",
  failed: "border-danger/40 bg-danger/10 text-danger",
  cancelled: "border-cat-entitled/40 bg-cat-entitled/10 text-cat-entitled",
};

const OVERALL_LABEL: Record<PipelineOverallState, string> = {
  queued: "Queued",
  running: "Running",
  done: "All done",
  failed: "Failed",
  cancelled: "Stopped",
};

const STAGE_TONE: Record<PipelineStageState, string> = {
  pending:
    "border-line bg-bg text-muted",
  running:
    "border-accent bg-accent/15 text-accent",
  done:
    "border-cat-ok/40 bg-cat-ok/10 text-cat-ok",
  failed:
    "border-danger/40 bg-danger/10 text-danger",
  cancelled:
    "border-cat-entitled/40 bg-cat-entitled/10 text-cat-entitled",
  skipped:
    "border-line/40 bg-transparent text-muted/60",
};

export default function LiveJobCard({
  job,
  onStop,
}: {
  job: ActiveJobView;
  /** Stop handler wired by LiveRunsClient. Absent (e.g. the SSR unit
   *  tests) means the per-run Stop button isn't rendered. */
  onStop?: (jobId: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const active = isJobActive(job);
  const now = useTickingNow(active);
  const stuck = isJobStuck(job, now);
  const elapsedMs = jobElapsedMs(job, now);
  const latest = job.events.at(-1) ?? null;

  return (
    <article
      className={`rounded-xl border bg-surface p-4 ${
        active ? (stuck ? "border-danger/40" : "border-accent/30") : "border-line"
      }`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link
            href={`/admin/reddit-sources/${job.reddit_id}`}
            className="block truncate text-ink hover:text-accent"
          >
            <span className="font-mono text-[11px] text-muted">
              r/{job.subreddit ?? "—"}
            </span>{" "}
            <span className="font-display text-[15px] font-bold tracking-tight">
              {job.title ?? job.reddit_id}
            </span>
          </Link>
          {latest && (
            <p className="mt-1 line-clamp-1 font-mono text-[11px] text-muted">
              <span className="text-accent">[{latest.event}]</span>{" "}
              {latest.message ?? ""}
            </p>
          )}
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
          <OverallChip overall={job.overall} />
          {stuck && <StuckBadge />}
          <ElapsedChip active={active} elapsedMs={elapsedMs} stuck={stuck} />
          {active && onStop && (
            <StopRunButton jobId={job.job_id} onStop={onStop} />
          )}
        </div>
      </header>

      <StagePillRow stages={job.stages} />

      <footer className="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="font-mono text-[10px] uppercase tracking-wider text-muted underline-offset-2 hover:text-accent hover:underline"
        >
          {open
            ? "Hide log"
            : `Show log${job.events.length ? ` (${job.events.length})` : ""}`}
        </button>
        <Link
          href={`/admin/reddit-sources/${job.reddit_id}`}
          className="font-mono text-[10px] uppercase tracking-wider text-accent hover:underline"
        >
          Open detail page →
        </Link>
      </footer>

      {open && <EventLog events={job.events} />}
    </article>
  );
}

function OverallChip({ overall }: { overall: PipelineOverallState }) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${OVERALL_TONE[overall]}`}
    >
      {OVERALL_LABEL[overall]}
    </span>
  );
}

/**
 * Step indicator showing each pipeline stage as its own pill. The
 * pills are positional (story → short → hero → publish), with a thin
 * connector between them for the visual progression. Skipped pills
 * (typically PUBLISH for non-full_pipeline sources) are dropped from
 * the rendered row so the card stays clean.
 */
function StagePillRow({ stages }: { stages: PipelineStage[] }) {
  const visible = stages.filter((s) => s.state !== "skipped");
  if (visible.length === 0) return null;
  return (
    <ol
      aria-label="Pipeline progress"
      className="mt-3 flex flex-wrap items-center gap-1.5"
    >
      {visible.map((stage, i) => (
        <li key={stage.id} className="flex items-center gap-1.5">
          <StagePill stage={stage} />
          {i < visible.length - 1 && (
            <span
              aria-hidden="true"
              className="block h-px w-3 bg-line"
            />
          )}
        </li>
      ))}
    </ol>
  );
}

function StagePill({ stage }: { stage: PipelineStage }) {
  const running = stage.state === "running";
  const tone = STAGE_TONE[stage.state];
  return (
    <span
      title={
        stage.sub_label
          ? `${stage.label} — ${stage.state} (${stage.sub_label})`
          : `${stage.label} — ${stage.state}`
      }
      aria-label={`${stage.label}: ${stage.state}`}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${tone}`}
    >
      {running && (
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
        />
      )}
      {!running && (
        <StageGlyph state={stage.state} />
      )}
      <span>{stage.label}</span>
    </span>
  );
}

/** Tiny per-state glyph (check / cross / dot) so the pill state reads
 *  without relying on colour alone (a11y). */
function StageGlyph({ state }: { state: PipelineStageState }) {
  if (state === "done") return <span aria-hidden>✓</span>;
  if (state === "failed") return <span aria-hidden>✗</span>;
  if (state === "cancelled") return <span aria-hidden>⏹</span>;
  // pending / skipped → small dot
  return (
    <span
      aria-hidden
      className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-50"
    />
  );
}

/** Ticking wall-clock, refreshed once a second while the run is active
 *  and frozen once it settles (no point burning a timer on a finished
 *  card). One timer per card; shared by the elapsed chip and the stuck
 *  check so they never disagree about "now". */
function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [active]);
  return now;
}

function ElapsedChip({
  active,
  elapsedMs,
  stuck,
}: {
  active: boolean;
  elapsedMs: number;
  stuck: boolean;
}) {
  // Active: time since requested_at, ticking. Settled: the frozen total
  // wall-clock (requested_at → last_settled_at). Computed by the shared
  // jobElapsedMs helper in the parent so the value drives both the chip
  // and the stuck flag.
  const label = formatElapsedSeconds(Math.floor(elapsedMs / 1000));
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
        stuck ? "border-danger/40 text-danger" : "border-line text-muted"
      }`}
    >
      {active ? label : `${label} total`}
    </span>
  );
}

/** Loud marker on a run that's been in flight past STUCK_THRESHOLD_MS —
 *  almost always a zombie (worker / render died without writing a
 *  terminal status). Drives the admin's eye to the Stop button. */
function StuckBadge() {
  return (
    <span
      title="In flight far longer than a healthy run takes. Its worker or render almost certainly died. Stop it to clear the card."
      className="inline-flex items-center gap-1 rounded-full border border-danger/50 bg-danger/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-danger"
    >
      <span aria-hidden>⚠</span>
      <span>Stuck</span>
    </span>
  );
}

/** Per-run Stop. Confirms (spend already incurred is non-refundable),
 *  then calls the parent handler which fires the server action and
 *  refetches. Local busy state guards against a double click. */
function StopRunButton({
  jobId,
  onStop,
}: {
  jobId: string;
  onStop: (jobId: string) => void | Promise<void>;
}) {
  const [stopping, setStopping] = useState(false);
  async function handleClick() {
    if (stopping) return;
    const ok = window.confirm(
      "Stop this run?\n\n" +
        "Whatever stage is still in flight (story / short / hero / publish) gets cancelled so the run drops off the live list.\n\n" +
        "If the article was already written it is kept. A run still in the story stage resets to 'imported' so you can re-queue it. Any spend already incurred is non-refundable.",
    );
    if (!ok) return;
    setStopping(true);
    try {
      await onStop(jobId);
    } finally {
      setStopping(false);
    }
  }
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={stopping}
      title="Cancel every in-flight stage of this run."
      className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-danger hover:opacity-80 disabled:opacity-50"
    >
      {stopping ? "Stopping…" : "Stop"}
    </button>
  );
}

function formatElapsedSeconds(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function EventLog({
  events,
}: {
  events: ActiveJobView["events"];
}) {
  if (events.length === 0) {
    return (
      <p className="mt-3 rounded-md border border-line bg-surface2/40 p-2 font-mono text-[10px] text-muted">
        No events recorded yet. The worker writes one event per phase
        as it processes the row.
      </p>
    );
  }
  const baselineTs = events[0].ts;
  return (
    <ol className="mt-3 max-h-[280px] space-y-1 overflow-y-auto rounded-md border border-line bg-surface2/40 p-2">
      {events.map((ev) => (
        <EventLine key={ev.id} ev={ev} baselineTs={baselineTs} />
      ))}
    </ol>
  );
}

function EventLine({
  ev,
  baselineTs,
}: {
  ev: ActiveJobView["events"][number];
  baselineTs: string;
}) {
  const tone =
    ev.level === "error"
      ? "text-danger"
      : ev.level === "warn"
        ? "text-cat-entitled"
        : "text-ink";
  const elapsed = formatElapsedBetween(baselineTs, ev.ts);
  const tail = tailFromPayload(ev.payload);
  const time = formatClock(ev.ts);
  return (
    <li
      className="flex items-start gap-2 font-mono text-[10px] leading-snug"
      title={ev.payload ?? undefined}
    >
      <span className="shrink-0 text-muted">{time}</span>
      <span className="shrink-0 text-accent">+{elapsed}</span>
      <span className="shrink-0 text-muted">[{ev.event}]</span>
      <span className={`${tone} break-words`}>
        {ev.message ?? ""}
        {tail ? <span className="ml-1 text-muted">{tail}</span> : null}
      </span>
    </li>
  );
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatElapsedBetween(fromIso: string, toIso: string): string {
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return "00:00";
  return formatElapsedSeconds(Math.floor((b - a) / 1000));
}

function tailFromPayload(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.story_id === "string") {
      return `· story=${truncate(data.story_id, 20)}`;
    }
    if (typeof data.error === "string") return `· ${truncate(data.error, 200)}`;
    if (typeof data.char_count === "number") {
      return `· ${data.char_count.toLocaleString()} chars`;
    }
    if (typeof data.headline === "string") {
      return `· ${truncate(data.headline, 80)}`;
    }
    if (typeof data.category === "string") return `· cat=${data.category}`;
    if (typeof data.cost_cents === "number") {
      return `· $${(data.cost_cents / 100).toFixed(2)}`;
    }
    if (typeof data.exc_type === "string") return `· ${data.exc_type}`;
    return null;
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
