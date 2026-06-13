"use client";

// RenderEventTimeline — expandable timeline of structured events for a
// single image_renders row. Mirrors what the Python worker writes via
// `store.log_render_event` (claim → prompt_built → kie_request_sent →
// kie_response_received → image_saved → done | error). Auto-polls every
// 3s while the parent row is in a transitional status; idle rows hold
// the last frame and don't re-fetch.
//
// Phase 2 of _plans/2026-06-13-worker-host-stop-button-observability.md.

import { useEffect, useRef, useState } from "react";
import type { RenderEventRow } from "@/lib/image-render-queue";
import { listRenderEventsAction } from "@/app/admin/actions";

export function RenderEventTimeline({
  renderId,
  isActive,
}: {
  renderId: string;
  /** When true the timeline polls every 3 s for new events; when false
   *  it loads once and stops. */
  isActive: boolean;
}) {
  const [open, setOpen] = useState(isActive);
  const [events, setEvents] = useState<RenderEventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);

  useEffect(() => {
    if (!open) return;
    stop.current = false;
    let cancelled = false;

    async function tick() {
      setLoading(true);
      try {
        const rows = await listRenderEventsAction(renderId);
        if (cancelled) return;
        setEvents(rows);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    tick();

    if (!isActive) return;
    const handle = window.setInterval(() => {
      if (stop.current) return;
      void tick();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [open, isActive, renderId]);

  return (
    <div className="mt-2">
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
              No events recorded yet for this regen.
            </p>
          )}
          {!error && events.length === 0 && loading && (
            <p className="font-mono text-[10px] text-muted">Loading…</p>
          )}
          {events.length > 0 && (
            <ol className="space-y-1">
              {events.map((ev) => (
                <EventLine key={ev.id} ev={ev} />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function EventLine({ ev }: { ev: RenderEventRow }) {
  const color =
    ev.level === "error"
      ? "text-danger"
      : ev.level === "warn"
        ? "text-warn"
        : "text-ink";
  const time = formatClock(ev.ts);
  return (
    <li className="flex items-start gap-2 font-mono text-[10px] leading-snug">
      <span className="shrink-0 text-muted">{time}</span>
      <span className="shrink-0 text-muted">[{ev.event}]</span>
      <span className={`${color} break-words`}>{ev.message ?? ""}</span>
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
