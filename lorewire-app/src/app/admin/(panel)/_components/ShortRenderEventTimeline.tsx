"use client";

// Inline progress log for one short_renders row. Direct port of
// VideoRenderEventTimeline (same dir) — reads from short_render_events via
// listShortRenderEventsAction.
//
// Lives under the ShortRenderControl progress bar so the admin sees the full
// lifecycle — click → queued → claimed → phase_script → phase_base →
// scene_generated × N → phase_voice → phase_render → finished — without
// tailing Vercel / Cloud Run logs. Auto-polls every 2 s while the parent row
// is queued / generating / rendering; settled rows load once and stop. The
// elapsed-time column is the "timelapse" view the user asked for: each line
// also shows time since the FIRST event so you can see at a glance which
// phase took longest.
//
// Plan: _plans/2026-06-15-short-render-events-and-cancel.md.

import { useEffect, useRef, useState } from "react";
import type { ShortRenderEventRow } from "@/lib/short-render-queue";
import { listShortRenderEventsAction } from "@/app/admin/videos/[id]/actions";

export function ShortRenderEventTimeline({
  renderId,
  isActive,
  defaultOpen = false,
}: {
  renderId: string;
  /** True while the parent row is queued / generating / rendering — drives polling. */
  isActive: boolean;
  /** If true the timeline starts expanded. Useful when the user just clicked
   *  Generate / Restart — they want to see what's happening immediately. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || isActive);
  const [events, setEvents] = useState<ShortRenderEventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

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
        const rows = await listShortRenderEventsAction(renderId);
        if (cancelledRef.current) return;
        setEvents(rows);
        setError(null);
        // eslint-disable-next-line no-console -- rule 14
        console.info("[short-events timeline poll]", {
          renderId,
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
  }, [open, isActive, renderId]);

  const baselineTs = events.length > 0 ? events[0].ts : null;

  return (
    <div className="mt-2 w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="font-mono text-[10px] uppercase tracking-wider text-muted underline-offset-2 hover:text-accent hover:underline"
      >
        {open ? "Hide log" : `Show log${events.length ? ` (${events.length})` : ""}`}
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-line bg-surface2/40 p-2">
          {error && (
            <p className="font-mono text-[10px] text-danger">log error: {error}</p>
          )}
          {!error && events.length === 0 && !loading && (
            <p className="font-mono text-[10px] text-muted">
              No events recorded yet for this render.
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
    </div>
  );
}

function EventLine({
  ev,
  baselineTs,
}: {
  ev: ShortRenderEventRow;
  baselineTs: string | null;
}) {
  const color =
    ev.level === "error"
      ? "text-danger"
      : ev.level === "warn"
        ? "text-warn"
        : "text-ink";
  const time = formatClock(ev.ts);
  const elapsed = baselineTs ? formatElapsed(baselineTs, ev.ts) : null;
  // Surface the payload's `url` / `error` / `status` / scene index next to the
  // message — those are the diagnostic signals the admin actually wants visible.
  // Full JSON stays in DevTools via the title attribute.
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
    if (typeof data.url === "string") return `· ${truncate(data.url, 80)}`;
    if (typeof data.error === "string") return `· ${truncate(data.error, 200)}`;
    if (typeof data.status === "string") return `· status=${data.status}`;
    if (
      typeof data.scene_index === "number" &&
      typeof data.scene_total === "number"
    ) {
      return `· ${data.scene_index}/${data.scene_total}`;
    }
    if (typeof data.phase === "string") return `· phase=${data.phase}`;
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

// "00:23", "01:47", "12:05" — elapsed since the first event of this render.
// This is the "timelapse" view: a single glance at the left column tells you
// which phase took the longest because the delta between adjacent rows is
// visible. We deliberately roll over at hours rather than padding to 3 digits
// because a short rendering past an hour is itself the diagnostic signal.
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
