"use client";

// Sticky action bar above the unified story editor's tab strip. Surfaces
// the three render gestures (Re-render / Generate / Restart) and the
// story status from EVERY tab, so a user editing on any tab can see
// "is a render in progress?" and kick one off without tab-hopping.
//
// Before this component shipped, those controls lived only on the Render
// tab (Re-render) and the legacy long-form editor (Generate / Restart),
// stranded behind a tab switch or the escape hatch.
//
// Plan: _plans/2026-06-25-story-action-bar-and-rail-restructure.md.

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  changeStatus,
  setStoryNoindexAction,
} from "@/app/admin/actions";
import { smartRerenderShort } from "@/app/admin/(panel)/shorts/[id]/actions";
import {
  getShortRenderStatusAction,
  queueShortRender,
  restartShortRenderAction,
} from "@/app/admin/videos/[id]/actions";
import {
  DEFAULT_LENGTH_PRESET,
  DEFAULT_NARRATION_VIBE,
  LENGTH_PRESETS,
} from "@/lib/shorts-options";
import type { ShortRenderRow } from "@/lib/short-render-queue";

const POLL_MS = 2500;

const STATUS_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "review", label: "In review" },
  { id: "ready", label: "Ready" },
  { id: "published", label: "Published" },
];

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

function renderProgressText(row: ShortRenderRow | null): string {
  if (!row) return "No short rendered yet";
  if (row.status === "queued") return "Queued…";
  if (row.status === "generating" || row.status === "rendering") {
    const label = PHASE_LABEL[row.phase ?? ""] ?? "Working…";
    return `${label} ${Math.round((row.progress ?? 0) * 100)}%`;
  }
  if (row.status === "done") {
    const finished = row.finished_at ?? row.requested_at;
    return finished
      ? `Last rendered ${formatRelative(finished)}`
      : "Last render complete";
  }
  if (row.status === "error") return `Last render failed: ${row.error ?? "unknown"}`;
  if (row.status === "cancelled") return "Last render cancelled";
  return row.status;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function statusPillClass(status: string): string {
  const s = status.toLowerCase();
  if (s === "published") return "bg-accent text-bg";
  if (s === "ready") return "bg-accent/20 text-accent";
  if (s === "archived") return "bg-muted/20 text-muted";
  return "bg-surface2 text-ink";
}

export function StoryActionBar({
  storyId,
  initialStatus,
  initialRender,
  initialNoindex,
}: {
  storyId: string;
  initialStatus: string | null | undefined;
  initialRender: ShortRenderRow | null;
  initialNoindex: boolean;
}) {
  const router = useRouter();
  const [render, setRender] = useState<ShortRenderRow | null>(initialRender);
  const [status, setStatus] = useState<string>(
    (initialStatus ?? "draft").toLowerCase(),
  );
  const [noindex, setNoindex] = useState(initialNoindex);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Popover/dropdown open state. Only one at a time.
  const [openPanel, setOpenPanel] = useState<
    "status" | "generate" | "restart" | "more" | null
  >(null);
  const [length, setLength] = useState<string>(
    initialRender?.length_preset ?? DEFAULT_LENGTH_PRESET,
  );

  // eslint-disable-next-line no-console -- rule 14 (observability)
  useEffect(() => {
    console.info("[action bar render]", {
      storyId,
      hasActiveRender: render !== null,
      currentStatus: status,
    });
    // Intentionally only logs on mount to keep the noise floor low.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll while a render is in flight. Stops on settle / unmount.
  const inFlight =
    render !== null &&
    (render.status === "queued" ||
      render.status === "generating" ||
      render.status === "rendering");
  useEffect(() => {
    if (!inFlight || !render) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    const id = render.id;
    pollRef.current = setInterval(async () => {
      try {
        const next = await getShortRenderStatusAction(id);
        if (next) {
          setRender(next);
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
  }, [inFlight, render, router]);

  // Close the open panel when the user clicks outside the bar. Cheap
  // global listener — only attached while a panel is open.
  const barRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!openPanel) return;
    function onClick(e: MouseEvent) {
      if (!barRef.current) return;
      if (e.target instanceof Node && !barRef.current.contains(e.target)) {
        setOpenPanel(null);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [openPanel]);

  function handleStatusChange(target: string) {
    setError(null);
    setOpenPanel(null);
    setStatus(target); // optimistic
    // eslint-disable-next-line no-console -- rule 14
    console.info("[action bar action]", {
      storyId,
      action: "status-change",
      from: status,
      to: target,
    });
    startTransition(async () => {
      const fd = new FormData();
      fd.set("id", storyId);
      fd.set("status", target);
      await changeStatus(fd);
      router.refresh();
    });
  }

  function handleArchive() {
    if (
      !confirm(
        "Archive this story? It will be hidden from public listings but not deleted.",
      )
    ) {
      return;
    }
    handleStatusChange("archived");
  }

  function handleReRender() {
    setError(null);
    // eslint-disable-next-line no-console -- rule 14
    console.info("[action bar action]", {
      storyId,
      action: "re-render",
      currentStatus: status,
    });
    startTransition(async () => {
      const result = await smartRerenderShort(storyId);
      if (!result.ok) {
        setError(result.error ?? "Re-render failed");
        return;
      }
      // Fetch the real row so polling picks it up and the user sees
      // "Queued…" immediately without waiting for the next refresh.
      if (result.renderId) {
        const row = await getShortRenderStatusAction(result.renderId);
        if (row) setRender(row);
      }
    });
  }

  function handleGenerate() {
    setError(null);
    setOpenPanel(null);
    // eslint-disable-next-line no-console -- rule 14
    console.info("[action bar action]", {
      storyId,
      action: "generate",
      length,
    });
    startTransition(async () => {
      const result = await queueShortRender(storyId, {
        narrationStyle: DEFAULT_NARRATION_VIBE,
        lengthPreset: length,
        force: true,
      });
      if (!result.ok) {
        setError(
          result.error === "daily-cap-exceeded"
            ? `Daily cap (${result.capLimit}) reached: ${result.capCount} in the last 24h.`
            : (result.error ?? "Generate failed"),
        );
        return;
      }
      if (result.render) setRender(result.render);
    });
  }

  function handleRestart() {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[action bar action]", {
      storyId,
      action: "restart",
      length,
    });
    setOpenPanel(null);
    startTransition(async () => {
      const result = await restartShortRenderAction(storyId, {
        narrationStyle: DEFAULT_NARRATION_VIBE,
        lengthPreset: length,
      });
      if (!result.ok) {
        setError(
          result.error === "daily-cap-exceeded"
            ? `Daily cap (${result.capLimit}) reached: ${result.capCount} in the last 24h.`
            : (result.error ?? "Restart failed"),
        );
        return;
      }
      if (result.render) setRender(result.render);
    });
  }

  function handleToggleNoindex() {
    setError(null);
    setOpenPanel(null);
    const next = !noindex;
    setNoindex(next); // optimistic
    // eslint-disable-next-line no-console -- rule 14
    console.info("[action bar action]", {
      storyId,
      action: "toggle-noindex",
      noindex: next,
    });
    startTransition(async () => {
      const fd = new FormData();
      fd.set("id", storyId);
      fd.set("noindex", next ? "1" : "0");
      await setStoryNoindexAction(fd);
      router.refresh();
    });
  }

  return (
    <div
      ref={barRef}
      className="sticky top-0 z-20 rounded-xl border border-line bg-surface px-3 py-2.5 shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* Status pill — click to change */}
        <div className="relative">
          <button
            type="button"
            onClick={() =>
              setOpenPanel(openPanel === "status" ? null : "status")
            }
            className={`flex items-center gap-1 rounded-full px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${statusPillClass(status)}`}
            aria-haspopup="menu"
            aria-expanded={openPanel === "status"}
          >
            <span aria-hidden>●</span>
            <span>{status}</span>
            <span className="opacity-60">▾</span>
          </button>
          {openPanel === "status" && (
            <div
              role="menu"
              className="absolute left-0 top-full z-30 mt-1 min-w-[180px] rounded-md border border-line bg-bg p-1 shadow-lg"
            >
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  role="menuitem"
                  onClick={() => handleStatusChange(opt.id)}
                  className={`block w-full rounded px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-surface ${
                    status === opt.id ? "text-accent" : "text-ink"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
              <div className="my-1 border-t border-line" />
              <button
                type="button"
                role="menuitem"
                onClick={handleArchive}
                className="block w-full rounded px-3 py-1.5 text-left text-[13px] text-muted transition-colors hover:bg-surface hover:text-ink"
              >
                Archive
              </button>
            </div>
          )}
        </div>

        <div className="h-5 w-px bg-line" aria-hidden />

        {/* Re-render */}
        <button
          type="button"
          onClick={handleReRender}
          disabled={inFlight}
          className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          title="Re-render the short with the current edits (picks the cheapest lane automatically)"
        >
          ▶ Re-render
        </button>

        {/* Generate (with length picker popover) */}
        <div className="relative">
          <button
            type="button"
            onClick={() =>
              setOpenPanel(openPanel === "generate" ? null : "generate")
            }
            disabled={inFlight}
            className="flex items-center gap-1 rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
            aria-haspopup="menu"
            aria-expanded={openPanel === "generate"}
          >
            <span aria-hidden>⚡</span>
            <span>Generate</span>
            <span className="opacity-60">▾</span>
          </button>
          {openPanel === "generate" && (
            <div
              role="menu"
              className="absolute left-0 top-full z-30 mt-1 w-[280px] rounded-md border border-line bg-bg p-3 shadow-lg"
            >
              <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted">
                Length
              </div>
              <div className="mb-3 space-y-1">
                {LENGTH_PRESETS.map((opt) => (
                  <label
                    key={opt.id}
                    className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-surface"
                  >
                    <input
                      type="radio"
                      name="length"
                      value={opt.id}
                      checked={length === opt.id}
                      onChange={() => setLength(opt.id)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="block text-[13px] text-ink">
                        {opt.label}
                      </span>
                      <span className="block text-[11px] text-muted">
                        {opt.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <button
                type="button"
                onClick={handleGenerate}
                className="w-full rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-bg transition-opacity hover:opacity-90"
              >
                Generate fresh short
              </button>
              {render !== null && (
                <p className="mt-2 text-[11px] text-muted">
                  Replaces the existing short for this story.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Restart (with confirm) */}
        <div className="relative">
          <button
            type="button"
            onClick={() =>
              setOpenPanel(openPanel === "restart" ? null : "restart")
            }
            disabled={inFlight}
            className="flex items-center gap-1 rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
            aria-haspopup="menu"
            aria-expanded={openPanel === "restart"}
            title="Throw away all short edits and re-render from scratch"
          >
            <span aria-hidden>⟲</span>
            <span>Restart</span>
          </button>
          {openPanel === "restart" && (
            <div
              role="menu"
              className="absolute left-0 top-full z-30 mt-1 w-[300px] rounded-md border border-warn bg-bg p-3 shadow-lg"
            >
              <p className="mb-2 text-[12px] text-ink">
                <strong>Restart this short?</strong>
              </p>
              <p className="mb-3 text-[11px] text-muted">
                Clears every per-scene edit, caption tweak, and short_config
                value. The pipeline re-seeds from scratch on the next render.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleRestart}
                  className="flex-1 rounded-md bg-warn px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-bg transition-opacity hover:opacity-90"
                >
                  Yes, restart
                </button>
                <button
                  type="button"
                  onClick={() => setOpenPanel(null)}
                  className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="h-5 w-px bg-line" aria-hidden />

        {/* More menu */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpenPanel(openPanel === "more" ? null : "more")}
            className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent"
            aria-haspopup="menu"
            aria-expanded={openPanel === "more"}
            title="Less-frequent story actions"
          >
            ⋯ More
          </button>
          {openPanel === "more" && (
            <div
              role="menu"
              className="absolute right-0 top-full z-30 mt-1 min-w-[220px] rounded-md border border-line bg-bg p-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                onClick={handleToggleNoindex}
                className="block w-full rounded px-3 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-surface"
              >
                {noindex
                  ? "Show in search engines"
                  : "Hide from search engines"}
              </button>
            </div>
          )}
        </div>

        <div className="ml-auto text-[11px] text-muted">
          {renderProgressText(render)}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-2 rounded border border-warn bg-warn/10 px-2 py-1 text-[11px] text-warn"
        >
          {error}
        </div>
      )}
    </div>
  );
}
