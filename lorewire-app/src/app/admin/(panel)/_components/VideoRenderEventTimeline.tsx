"use client";

// Inline progress log for one video_renders row. Mirrors the
// image-render variant (RenderEventTimeline.tsx) but reads from the
// video_render_events table via `listVideoRenderEventsAction`.
//
// Lives under the Render button in the editor so the admin sees the
// full lifecycle — click → reset_from_error → claim → dispatch →
// cloud_run_response → finish — without tailing Vercel logs.
// Auto-polls every 2 s while the parent row is queued or rendering;
// settled rows load once and stop. Survives unmount cleanly so the
// polling interval can't leak.

import { useEffect, useRef, useState } from "react";
import type { VideoRenderEventRow } from "@/lib/video-render-queue";
import { listVideoRenderEventsAction } from "@/app/admin/videos/[id]/actions";

export function VideoRenderEventTimeline({
  renderId,
  isActive,
  defaultOpen = false,
}: {
  renderId: string;
  /** True while the parent row is queued/rendering — drives polling. */
  isActive: boolean;
  /** If true the timeline starts expanded. Useful when the user just
   *  clicked Render — they want to see what happened immediately. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || isActive);
  const [events, setEvents] = useState<VideoRenderEventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  // Auto-open when the row becomes active (user just clicked Render and
  // the row is queued → user expects to see the timeline immediately).
  // React 19 lint rule forbids setState in an effect for this kind of
  // prop-driven sync; the sanctioned pattern is to track the previous
  // prop value during render and update state inline.
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
        const rows = await listVideoRenderEventsAction(renderId);
        if (cancelledRef.current) return;
        setEvents(rows);
        setError(null);
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

  return (
    <div className="mt-2 w-full max-w-md">
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
                <EventLine key={ev.id} ev={ev} />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function EventLine({ ev }: { ev: VideoRenderEventRow }) {
  const color =
    ev.level === "error"
      ? "text-danger"
      : ev.level === "warn"
        ? "text-warn"
        : "text-ink";
  const time = formatClock(ev.ts);
  // Surface the payload's `error` or `url` fields next to the message
  // since those are the diagnostic signals the admin actually wants
  // visible. The full JSON stays in DevTools via the title attribute.
  const tail = tailFromPayload(ev.payload);
  return (
    <li
      className="flex items-start gap-2 font-mono text-[10px] leading-snug"
      title={ev.payload ?? undefined}
    >
      <span className="shrink-0 text-muted">{time}</span>
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
