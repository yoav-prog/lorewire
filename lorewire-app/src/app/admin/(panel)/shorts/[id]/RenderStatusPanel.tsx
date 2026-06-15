"use client";

// Render status surface for the short editor. After the user clicks
// "Render after edits" the action queues a row but the editor previously
// gave no visible feedback that anything was happening — the preview
// drives off the live ShortConfig, not the rendered MP4. This panel
// fixes that: it polls the latest render's status every 2.5 s while
// in-flight, shows a status badge + error string + the rendered MP4
// when done, and mounts the existing ShortRenderEventTimeline for the
// per-phase log.
//
// Polls only while in-flight; settled rows stop polling. router.refresh()
// fires once the row hits 'done' so server state (the editor's
// initialRender prop) catches up.
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md (editor visibility).

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ShortRenderEventTimeline } from "@/app/admin/(panel)/_components/ShortRenderEventTimeline";
import {
  getShortRenderStatusAction,
} from "@/app/admin/videos/[id]/actions";
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

function statusBadge(row: ShortRenderRow | null): {
  label: string;
  tone: "queued" | "running" | "done" | "error" | "cancelled" | "none";
} {
  if (!row) return { label: "—", tone: "none" };
  if (row.status === "queued")
    return { label: "Queued · waiting for drain", tone: "queued" };
  if (row.status === "generating" || row.status === "rendering") {
    const phase = PHASE_LABEL[row.phase ?? ""] ?? "Working…";
    const pct = Math.round((row.progress ?? 0) * 100);
    return { label: `${phase} ${pct}%`, tone: "running" };
  }
  if (row.status === "done") return { label: "Done", tone: "done" };
  if (row.status === "error")
    return { label: `Failed: ${row.error ?? "unknown"}`, tone: "error" };
  if (row.status === "cancelled") return { label: "Cancelled", tone: "cancelled" };
  return { label: row.status, tone: "none" };
}

export function RenderStatusPanel({
  initialRender,
}: {
  initialRender: ShortRenderRow | null;
}) {
  const router = useRouter();
  const [row, setRow] = useState<ShortRenderRow | null>(initialRender);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previousStatusRef = useRef<string | null>(initialRender?.status ?? null);

  // Mirror server state changes (router.refresh from the banner) into
  // local state so the badge updates without waiting for a poll tick.
  useEffect(() => {
    setRow(initialRender);
    previousStatusRef.current = initialRender?.status ?? null;
  }, [initialRender]);

  const inFlight =
    row !== null &&
    (row.status === "queued" ||
      row.status === "generating" ||
      row.status === "rendering");

  useEffect(() => {
    if (!inFlight || !row) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    const id = row.id;
    pollRef.current = setInterval(async () => {
      try {
        const next = await getShortRenderStatusAction(id);
        if (next) {
          setRow(next);
          // Settled — refresh server props so the editor's other surfaces
          // (preview voiceover_url if the render rewrote it, ScenesTab
          // "last render" hint, etc.) catch up.
          if (
            previousStatusRef.current !== "done" &&
            next.status === "done"
          ) {
            previousStatusRef.current = "done";
            router.refresh();
          } else {
            previousStatusRef.current = next.status;
          }
        }
      } catch {
        /* transient poll error, retry next tick */
      }
    }, POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [inFlight, row, router]);

  if (!row) {
    return (
      <div className="rounded-lg border border-line bg-surface p-3 text-[12px] text-muted">
        No short rendered yet — generate one from the video editor first.
      </div>
    );
  }

  const badge = statusBadge(row);
  const toneClass = {
    queued:
      "bg-surface text-ink border-line",
    running:
      "bg-accent/10 text-accent border-accent/40 animate-pulse",
    done: "bg-accent/15 text-accent border-accent",
    error: "bg-warn/10 text-warn border-warn",
    cancelled: "bg-surface text-muted border-line",
    none: "bg-surface text-muted border-line",
  }[badge.tone];

  return (
    <section className="space-y-2 rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Latest render
        </span>
        <span
          className={`rounded-md border px-2 py-1 font-mono text-[11px] uppercase tracking-wider ${toneClass}`}
        >
          {badge.label}
        </span>
        {inFlight && (
          <div className="ml-1 h-1.5 flex-1 overflow-hidden rounded-full bg-fg/10">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{
                width: `${Math.max(4, Math.round((row.progress ?? 0) * 100))}%`,
              }}
            />
          </div>
        )}
      </div>

      {row.status === "done" && row.output_url && (
        <div className="flex flex-wrap items-center gap-3">
          <video
            src={row.output_url}
            controls
            playsInline
            className="aspect-[9/16] w-32 self-start rounded-md border border-line bg-black"
          />
          <div className="flex flex-col gap-1 text-[12px]">
            <a
              href={row.output_url}
              download
              className="font-mono text-[11px] text-accent underline"
            >
              Download MP4
            </a>
            <span className="font-mono text-[10px] text-muted">
              {row.lane ? `Lane ${row.lane}` : "Full render"}
            </span>
          </div>
        </div>
      )}

      <ShortRenderEventTimeline
        renderId={row.id}
        isActive={inFlight}
        defaultOpen={inFlight}
      />
    </section>
  );
}
