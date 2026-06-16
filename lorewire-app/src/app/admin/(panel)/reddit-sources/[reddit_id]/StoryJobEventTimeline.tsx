"use client";

// Inline progress log for one reddit_id's latest story_jobs row. Direct
// port of ShortRenderEventTimeline (admin/(panel)/_components/) — reads
// from story_job_events via listStoryJobEventsForRedditAction.
//
// Lives on the per-row review page so the admin sees the full lifecycle —
// queued -> claimed -> idea_done -> research_done -> article_done ->
// title_done -> media_done -> video_render_enqueued / forced_short ->
// finished — without tailing the worker terminal. Auto-polls every 2s
// while the source row is queued / processing; settled rows load once
// and stop. The elapsed-time column tells you at a glance which phase
// took longest.
//
// Plan: _plans/2026-06-16-story-job-event-timeline.md.

import { useEffect, useRef, useState } from "react";
import type { StoryJobEventRow } from "@/lib/story-jobs";
import { listStoryJobEventsForRedditAction } from "@/app/admin/actions";

export default function StoryJobEventTimeline({
  redditId,
  isActive,
  defaultOpen = false,
}: {
  redditId: string;
  /** True while the source row is queued / processing — drives polling. */
  isActive: boolean;
  /** If true the timeline starts expanded. The detail page opens it by
   *  default when the row is active so the admin sees what's happening
   *  the moment the page loads. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || isActive);
  const [events, setEvents] = useState<StoryJobEventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  // When the row transitions from inactive to active (e.g. the admin
  // just clicked Process and the page rendered immediately after), open
  // the log so the kickoff is visible without an extra click.
  const [prevActive, setPrevActive] = useState(isActive);
  if (isActive !== prevActive) {
    setPrevActive(isActive);
    if (isActive && !open) setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    cancelledRef.current = false;

    async function tick() {
      setLoading(true);
      try {
        const rows = await listStoryJobEventsForRedditAction(redditId);
        if (cancelledRef.current) return;
        setEvents(rows);
        setError(null);
        // eslint-disable-next-line no-console -- rule 14
        console.info("[story-events timeline poll]", {
          redditId,
          count: rows.length,
        });
      } catch (e) {
        if (cancelledRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelledRef.current) setLoading(false);
      }
    }

    void tick();

    if (!isActive) return;
    const handle = window.setInterval(() => {
      void tick();
    }, 2000);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(handle);
    };
  }, [open, isActive, redditId]);

  const baselineTs = events.length > 0 ? events[0].ts : null;

  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted">
          Per-row activity log
          {isActive && (
            <span className="ml-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          )}
        </h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="font-mono text-[10px] uppercase tracking-wider text-muted underline-offset-2 hover:text-accent hover:underline"
        >
          {open
            ? "Hide log"
            : `Show log${events.length ? ` (${events.length})` : ""}`}
        </button>
      </header>
      {open && (
        <div className="mt-3 rounded-md border border-line bg-surface2/40 p-2">
          {error && (
            <p className="font-mono text-[10px] text-danger">
              log error: {error}
            </p>
          )}
          {!error && events.length === 0 && !loading && (
            <p className="font-mono text-[10px] text-muted">
              No events recorded yet. Worker writes events as it claims
              and processes the row; if the queue is stuck, start a worker
              locally with{" "}
              <code className="text-ink">
                python -m pipeline.story_jobs_worker
              </code>
              .
            </p>
          )}
          {!error && events.length === 0 && loading && (
            <p className="font-mono text-[10px] text-muted">Loading…</p>
          )}
          {events.length > 0 && (
            <ol className="space-y-1">
              {events.map((ev) => (
                <EventLine key={ev.id} ev={ev} baselineTs={baselineTs} />
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

function EventLine({
  ev,
  baselineTs,
}: {
  ev: StoryJobEventRow;
  baselineTs: string | null;
}) {
  const color =
    ev.level === "error"
      ? "text-danger"
      : ev.level === "warn"
        ? "text-cat-entitled"
        : "text-ink";
  const time = formatClock(ev.ts);
  const elapsed = baselineTs ? formatElapsed(baselineTs, ev.ts) : null;
  const tail = tailFromPayload(ev.payload);
  return (
    <li
      className="flex items-start gap-2 font-mono text-[10px] leading-snug"
      title={ev.payload ?? undefined}
    >
      <span className="shrink-0 text-muted">{time}</span>
      {elapsed && <span className="shrink-0 text-accent">+{elapsed}</span>}
      <span className="shrink-0 text-muted">[{ev.event}]</span>
      <span className={`${color} break-words`}>
        {ev.message ?? ""}
        {tail ? <span className="ml-1 text-muted">{tail}</span> : null}
      </span>
    </li>
  );
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

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// "00:23", "01:47", "12:05" — elapsed since the first event of this job.
// Single glance at the left column tells you which phase took the longest
// because the delta between adjacent rows is visible. Rolls over at hours
// rather than padding to 3 digits because a story job past an hour is
// itself the diagnostic signal.
function formatElapsed(baselineIso: string, atIso: string): string {
  const a = new Date(baselineIso).getTime();
  const b = new Date(atIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return "00:00";
  const ms = b - a;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
