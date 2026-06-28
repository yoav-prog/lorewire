"use client";

// One card per active or recently-finished story job. Collapsed view
// shows the header + status + latest event line so a 20-row batch
// renders without becoming a wall of text. Expanded view shows the
// full event log (capped at MAX_EVENTS_PER_JOB by the data layer) with
// elapsed-from-start times, mirroring StoryJobEventTimeline's idiom.
//
// Card click target is the title link → per-row review page. The card
// itself doesn't capture clicks because every actionable element wants
// its own hit area for accessibility.
//
// Plan: _plans/2026-06-28-reddit-sources-live-runs-page.md.

import { useEffect, useState } from "react";
import Link from "next/link";
import { isJobActive, type ActiveJobView } from "@/lib/story-jobs-live-shared";

const STATUS_TONE: Record<string, string> = {
  queued: "border-accent/40 bg-accent/10 text-accent",
  processing: "border-accent/40 bg-accent/15 text-accent",
  done: "border-cat-ok/40 bg-cat-ok/10 text-cat-ok",
  error: "border-danger/40 bg-danger/10 text-danger",
  cancelled: "border-cat-entitled/40 bg-cat-entitled/10 text-cat-entitled",
};

export default function LiveJobCard({ job }: { job: ActiveJobView }) {
  const [open, setOpen] = useState(false);
  const active = isJobActive(job);
  const latest = job.events.at(-1) ?? null;

  return (
    <article
      className={`rounded-xl border bg-surface p-4 ${
        active ? "border-accent/30" : "border-line"
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
          <StatusChip status={job.status} />
          <ElapsedChip job={job} />
        </div>
      </header>

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

function StatusChip({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "border-line text-muted";
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${tone}`}
    >
      {status}
    </span>
  );
}

function ElapsedChip({ job }: { job: ActiveJobView }) {
  // For active jobs: time since requested_at, ticking.
  // For finished jobs: wall-clock from requested_at to finished_at.
  const active = isJobActive(job);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [active]);

  const start = new Date(job.requested_at).getTime();
  const end = active
    ? now
    : job.finished_at
      ? new Date(job.finished_at).getTime()
      : now;
  const elapsedSec = Math.max(0, Math.floor((end - start) / 1000));
  const label = formatElapsedSeconds(elapsedSec);
  return (
    <span className="inline-block rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
      {active ? label : `${label} total`}
    </span>
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
