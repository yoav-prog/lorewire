"use client";

// "Generate short" control for the video editor. Sits next to the long-form
// RenderControl. Lets the admin pick a narration vibe + length preset, enqueue a
// short render (queueShortRender), and watch progress (phase + bar) by polling
// getShortRenderStatusAction. When done it shows the rendered MP4 inline.
//
// Self-contained: fetches its own latest short render on mount so it survives a
// reload, so mounting it only needs `storyId`. Mirrors the RenderControl polling
// pattern in EditorClient.tsx (server-action poll instead of the /api route).

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  cancelShortRenderAction,
  getShortRenderStatusAction,
  latestShortRenderAction,
  queueShortRender,
  restartShortRenderAction,
  useShortAsStoryVideo,
} from "./actions";
import {
  DEFAULT_LENGTH_PRESET,
  DEFAULT_NARRATION_VIBE,
  LENGTH_PRESETS,
  NARRATION_VIBES,
} from "@/lib/shorts-options";
import type { ShortRenderRow } from "@/lib/short-render-queue";
import { ShortRenderEventTimeline } from "@/app/admin/(panel)/_components/ShortRenderEventTimeline";

const POLL_MS = 2500;

const PHASE_LABEL: Record<string, string> = {
  script: "Writing script…",
  plan: "Planning scenes…",
  base: "Drawing character…",
  scene: "Drawing scenes…",
  voice: "Recording voiceover…",
  stage: "Assembling…",
  render: "Rendering video…",
  done: "Done",
};

function statusText(row: ShortRenderRow | null): string {
  if (!row) return "";
  if (row.status === "queued") return "Queued…";
  if (row.status === "generating" || row.status === "rendering") {
    const label = PHASE_LABEL[row.phase ?? ""] ?? "Working…";
    return `${label} ${Math.round((row.progress ?? 0) * 100)}%`;
  }
  if (row.status === "done") return "Short ready";
  if (row.status === "error") return `Failed: ${row.error ?? "unknown error"}`;
  if (row.status === "cancelled") return "Cancelled";
  return row.status;
}

export default function ShortRenderControl({ storyId }: { storyId: string }) {
  const router = useRouter();
  const [vibe, setVibe] = useState(DEFAULT_NARRATION_VIBE);
  const [length, setLength] = useState(DEFAULT_LENGTH_PRESET);
  const [active, setActive] = useState<ShortRenderRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load the latest short render once on mount so prior state shows after a reload.
  useEffect(() => {
    let cancelled = false;
    latestShortRenderAction(storyId)
      .then((row) => {
        if (!cancelled && row) {
          setActive(row);
          setVibe(row.narration_style ?? DEFAULT_NARRATION_VIBE);
          setLength(row.length_preset ?? DEFAULT_LENGTH_PRESET);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [storyId]);

  const inFlight =
    active !== null &&
    (active.status === "queued" ||
      active.status === "generating" ||
      active.status === "rendering");

  // Poll while a render is in flight; stop on settle/unmount.
  useEffect(() => {
    if (!inFlight || !active) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    const id = active.id;
    pollRef.current = setInterval(async () => {
      try {
        const next = await getShortRenderStatusAction(id);
        if (next) {
          setActive(next);
          if (next.status === "done") router.refresh();
        }
      } catch {
        /* transient poll error, retry next tick */
      }
    }, POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [inFlight, active, router]);

  const handleGenerate = () => {
    setError(null);
    startTransition(async () => {
      // force: a click always (re)generates. Without it, clicking with the same
      // vibe + length as an existing finished short was an idempotent no-op, so
      // the button looked dead. force discards the old short and runs a fresh
      // generation; it's ignored when no short exists yet.
      const result = await queueShortRender(storyId, {
        narrationStyle: vibe,
        lengthPreset: length,
        force: true,
      });
      if (!result.ok) {
        setError(
          result.error === "daily-cap-exceeded"
            ? `Daily short cap (${result.capLimit}) reached: ${result.capCount} in the last 24h. Bump shorts.daily_renders_per_story to lift it.`
            : (result.error ?? "Enqueue failed"),
        );
        return;
      }
      if (result.render) setActive(result.render);
    });
  };

  // Stop: cancel the in-flight short. Status-gated server-side (only queued /
  // generating rows get flipped; rendering is past the cancel window). The
  // worker checks status before each phase and aborts cleanly — see
  // _plans/2026-06-15-short-render-events-and-cancel.md.
  const handleStop = () => {
    if (!active?.id) return;
    setError(null);
    const renderId = active.id;
    startTransition(async () => {
      const result = await cancelShortRenderAction(renderId);
      if (!result.ok) {
        setError(result.error ?? "Cancel failed");
        return;
      }
      // Refresh status so the button set updates without waiting for the
      // next poll tick (cancel is fast; users expect an instant response).
      const next = await getShortRenderStatusAction(renderId);
      if (next) setActive(next);
    });
  };

  // Restart: re-queue a settled (done / error / cancelled) row. Same config
  // (vibe + length), force=true so generation runs fresh.
  const handleRestart = () => {
    setError(null);
    startTransition(async () => {
      const result = await restartShortRenderAction(storyId, {
        narrationStyle: vibe,
        lengthPreset: length,
      });
      if (!result.ok) {
        setError(
          result.error === "daily-cap-exceeded"
            ? `Daily short cap (${result.capLimit}) reached: ${result.capCount} in the last 24h. Bump shorts.daily_renders_per_story to lift it.`
            : (result.error ?? "Restart failed"),
        );
        return;
      }
      if (result.render) setActive(result.render);
    });
  };

  // True when the row is in the cancel window — queued or generating. We hide
  // Stop during `rendering` because Cloud Run has the MP4 in flight and there
  // is no clean abort seam there (matches image-render cancel scope).
  const canStop =
    active !== null &&
    (active.status === "queued" || active.status === "generating");

  // True when the row is settled and Restart applies. `done` shows Restart
  // alongside the rendered video; `error` and `cancelled` show Restart
  // instead of the disabled-status text.
  const isSettled =
    active !== null &&
    (active.status === "done" ||
      active.status === "error" ||
      active.status === "cancelled");

  const handleApply = () => {
    if (!active?.id) return;
    setApplyMsg(null);
    startTransition(async () => {
      const r = await useShortAsStoryVideo(storyId, active.id);
      if (r.ok) {
        setApplyMsg("Applied — the article now uses this short.");
        router.refresh();
      } else {
        setApplyMsg(r.error ?? "Failed to apply.");
      }
    });
  };

  const busy = pending || inFlight;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-fg/10 bg-bg/40 p-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-fg/70">
          Generate short
        </span>
        {active && (
          <span className="font-mono text-[11px] text-fg/60">{statusText(active)}</span>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-fg/50">Vibe</span>
          <select
            value={vibe}
            onChange={(e) => setVibe(e.target.value)}
            disabled={busy}
            className="rounded-md border border-fg/15 bg-bg px-2 py-1 font-mono text-[11px] text-fg disabled:opacity-60"
          >
            {NARRATION_VIBES.map((o) => (
              <option key={o.id} value={o.id} title={o.description}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-fg/50">Length</span>
          <select
            value={length}
            onChange={(e) => setLength(e.target.value)}
            disabled={busy}
            className="rounded-md border border-fg/15 bg-bg px-2 py-1 font-mono text-[11px] text-fg disabled:opacity-60"
          >
            {LENGTH_PRESETS.map((o) => (
              <option key={o.id} value={o.id} title={o.description}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        {inFlight ? (
          <button
            type="button"
            disabled
            className="rounded-md bg-accent/60 px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg disabled:cursor-wait"
          >
            {statusText(active) || "Queueing…"}
          </button>
        ) : isSettled ? (
          <button
            type="button"
            onClick={handleRestart}
            disabled={pending}
            className="rounded-md bg-accent px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
          >
            Restart
          </button>
        ) : (
          <button
            type="button"
            onClick={handleGenerate}
            disabled={pending}
            className="rounded-md bg-accent px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
          >
            Generate short
          </button>
        )}

        {canStop && (
          <button
            type="button"
            onClick={handleStop}
            disabled={pending}
            className="rounded-md border border-red-500/40 bg-bg px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-red-500 transition-colors hover:border-red-500 hover:bg-red-500/10 disabled:cursor-wait disabled:opacity-60"
            title="Cancel the in-flight short. Anything already uploaded to GCS is kept for a future Restart."
          >
            Stop
          </button>
        )}
      </div>

      {inFlight && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-fg/10">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${Math.max(4, Math.round((active?.progress ?? 0) * 100))}%` }}
          />
        </div>
      )}

      {/* Live event timeline with timelapse-elapsed column. Active while the
          row is queued / generating / rendering; on settled rows it loads once
          and stops polling. */}
      {active?.id && (
        <ShortRenderEventTimeline
          renderId={active.id}
          isActive={inFlight}
          defaultOpen={inFlight}
        />
      )}

      {error && <p className="font-mono text-[11px] text-red-500">{error}</p>}

      {active?.status === "done" && active.output_url && (
        <div className="flex flex-col gap-1">
          <video
            src={active.output_url}
            controls
            playsInline
            className="aspect-[9/16] w-40 self-start rounded-md border border-fg/10 bg-black"
          />
          <div className="flex items-center gap-3">
            <a
              href={active.output_url}
              download
              className="font-mono text-[11px] text-accent underline"
            >
              Download short
            </a>
            <button
              type="button"
              onClick={handleApply}
              disabled={busy}
              className="rounded-md border border-fg/20 px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-wider text-fg transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
              title="Replace the article's video with this short (reversible)"
            >
              Use as article video
            </button>
          </div>
          {applyMsg && <p className="font-mono text-[11px] text-fg/70">{applyMsg}</p>}
        </div>
      )}
    </div>
  );
}
