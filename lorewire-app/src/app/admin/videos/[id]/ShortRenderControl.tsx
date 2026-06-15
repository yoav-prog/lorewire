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
  getShortRenderStatusAction,
  latestShortRenderAction,
  queueShortRender,
} from "./actions";
import {
  DEFAULT_LENGTH_PRESET,
  DEFAULT_NARRATION_VIBE,
  LENGTH_PRESETS,
  NARRATION_VIBES,
} from "@/lib/shorts-options";
import type { ShortRenderRow } from "@/lib/short-render-queue";

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
  if (row.status === "rendering") {
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
    (active.status === "queued" || active.status === "rendering");

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
      const result = await queueShortRender(storyId, {
        narrationStyle: vibe,
        lengthPreset: length,
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

        <button
          type="button"
          onClick={handleGenerate}
          disabled={busy}
          className="rounded-md bg-accent px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? statusText(active) || "Queueing…" : "Generate short"}
        </button>
      </div>

      {inFlight && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-fg/10">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${Math.max(4, Math.round((active?.progress ?? 0) * 100))}%` }}
          />
        </div>
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
          <a
            href={active.output_url}
            download
            className="font-mono text-[11px] text-accent underline"
          >
            Download short
          </a>
        </div>
      )}
    </div>
  );
}
