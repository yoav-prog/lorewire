"use client";

// Render status surface for the short editor. Polls the active render's
// status every 2.5 s while in-flight, shows a tone-coded badge, embeds
// the rendered MP4 when done, and mounts the existing
// ShortRenderEventTimeline below for the per-phase log.
//
// Active render id is HOISTED into ShortEditorClient state (not derived
// from server props), so the banner can hand the panel the just-queued
// id directly via onRenderQueued — no waiting for router.refresh() to
// re-flow server props. The initial value comes from initialRender.id
// (the editor's load) so a page-cold-start still surfaces whatever was
// last in-flight.
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

// Belt-and-braces companion to the server-side Cache-Control: every short
// re-render overwrites the SAME GCS key (one canonical MP4 per story), so
// without a per-render query param a browser cache that ignores the
// no-cache header would happily replay the previous MP4. We append the
// render row id (stable, monotonic per render) so each Lane A/B/C run
// gets a distinct URL the cache can't conflate with the prior one.
// finished_at is a fine fallback when id isn't suitable, but id is stable
// across the editor's re-renders of the same row.
function withRenderCacheBuster(
  url: string,
  row: { id: string; finished_at?: string | null },
): string {
  const tag = row.finished_at ?? row.id;
  if (!tag) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${encodeURIComponent(tag)}`;
}

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
    return { label: "Queued — drain dispatched", tone: "queued" };
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
  activeRenderId,
  initialRender,
}: {
  /** Live client-side render id, hoisted into ShortEditorClient and
   *  bumped by the banner on a successful enqueue. Falls back to
   *  initialRender.id when null (page-cold-start). */
  activeRenderId: string | null;
  /** Page-load snapshot, used to seed the first poll without waiting
   *  for the client to learn the id. Null when no short exists yet. */
  initialRender: ShortRenderRow | null;
}) {
  const router = useRouter();
  // The "tracked" render id we poll for. Resolves to activeRenderId when
  // set (client state); otherwise initialRender.id; otherwise null.
  const trackedId = activeRenderId ?? initialRender?.id ?? null;

  const [row, setRow] = useState<ShortRenderRow | null>(() => {
    if (initialRender && initialRender.id === trackedId) return initialRender;
    return null;
  });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previousStatusRef = useRef<string | null>(row?.status ?? null);

  // Tracked id changes (banner queued a new render). Reset local state
  // and let the next poll tick (or the immediate fetch below) populate.
  useEffect(() => {
    if (!trackedId) {
      setRow(null);
      previousStatusRef.current = null;
      return;
    }
    // If we already have the matching row (page load), keep it.
    if (row && row.id === trackedId) return;
    // Otherwise: clear stale state and trigger an immediate fetch so the
    // user sees the badge update within ~100 ms of the click instead of
    // waiting for the first poll interval to tick.
    setRow(null);
    previousStatusRef.current = null;
    let cancelled = false;
    getShortRenderStatusAction(trackedId)
      .then((next) => {
        if (cancelled || !next) return;
        setRow(next);
        previousStatusRef.current = next.status;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: row is read inside but a change shouldn't re-fire the fetch
  }, [trackedId]);

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
          if (
            previousStatusRef.current !== "done" &&
            next.status === "done"
          ) {
            previousStatusRef.current = "done";
            // Refresh server props so other surfaces (preview voiceover
            // url after Lane B, etc.) catch up.
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

  if (!trackedId || !row) {
    return null;
  }

  const badge = statusBadge(row);
  const toneClass = {
    queued: "bg-accent/10 text-accent border-accent/40 animate-pulse",
    running: "bg-accent/10 text-accent border-accent/40 animate-pulse",
    done: "bg-accent/15 text-accent border-accent",
    error: "bg-warn/10 text-warn border-warn",
    cancelled: "bg-surface text-muted border-line",
    none: "bg-surface text-muted border-line",
  }[badge.tone];

  return (
    <section className="space-y-2 rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Render
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
            src={withRenderCacheBuster(row.output_url, row)}
            controls
            playsInline
            className="aspect-[9/16] w-32 self-start rounded-md border border-line bg-black"
          />
          <div className="flex flex-col gap-1 text-[12px]">
            <a
              href={withRenderCacheBuster(row.output_url, row)}
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

      {row.status === "error" && row.error && (
        <p className="rounded-md border border-warn bg-warn/10 px-3 py-2 font-mono text-[11px] text-warn">
          {row.error}
        </p>
      )}

      <ShortRenderEventTimeline
        renderId={row.id}
        isActive={inFlight}
        defaultOpen={inFlight}
      />
    </section>
  );
}
