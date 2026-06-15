"use client";

// Scenes tab — Phase 1 of the short editor.
//
// Grid of doodle_frames, each with:
//   - thumbnail of the current url
//   - editable prompt (textarea) + alt (input)
//   - "Regenerate scene" button (enqueues image_renders with
//      owner_kind='short_scene')
//   - pin toggle (is_pinned protects this frame from a future full Regenerate)
//   - "Revert to prior" link when prev_image is set
//
// Edits debounce + autosave via saveShortConfigPatch. Regen is explicit
// (no autosave on click — the admin pays per scene).
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ShortConfig, ShortFrame } from "@/lib/short-config";
import type { ShortRenderRow } from "@/lib/short-render-queue";
import { SceneArticleActions } from "./SceneArticleActions";
import type { LinkedArticleSummary } from "./actions";
import {
  regenShortScene,
  revertShortScene,
  saveShortConfigPatch,
  setFrameIsPinned,
} from "./actions";

const SAVE_DEBOUNCE_MS = 1500;

interface DraftPrompt {
  imagePrompt: string;
  alt: string;
}

export function ScenesTab({
  storyId,
  config,
  onConfigChange,
  initialRender,
  linkedArticles,
}: {
  storyId: string;
  config: ShortConfig;
  onConfigChange: (next: ShortConfig) => void;
  initialRender: ShortRenderRow | null;
  /** Articles whose articles.story_id matches this story. Drives the
   *  per-scene "Use in article" action panel. */
  linkedArticles: LinkedArticleSummary[];
}) {
  const router = useRouter();
  const frames = config.doodle_frames;
  const [draft, setDraft] = useState<Record<string, DraftPrompt>>(() =>
    Object.fromEntries(
      frames.map((f) => [
        f.id,
        { imagePrompt: f.image_prompt ?? "", alt: f.alt ?? "" },
      ]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [savingFrameId, setSavingFrameId] = useState<string | null>(null);
  const [pendingRegen, setPendingRegen] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Reset drafts when the parent config refreshes (e.g. after a regen completes
  // and the page re-renders with the new image url).
  const configKey = useMemo(
    () => frames.map((f) => `${f.id}:${f.url}`).join("|"),
    [frames],
  );
  useEffect(() => {
    setDraft((prev) => {
      const next: Record<string, DraftPrompt> = { ...prev };
      for (const f of frames) {
        if (!next[f.id]) {
          next[f.id] = {
            imagePrompt: f.image_prompt ?? "",
            alt: f.alt ?? "",
          };
        }
      }
      return next;
    });
  }, [configKey, frames]);

  useEffect(() => {
    return () => {
      for (const t of Object.values(saveTimers.current)) clearTimeout(t);
    };
  }, []);

  function scheduleSave(frameId: string, patch: Record<string, unknown>) {
    if (saveTimers.current[frameId]) clearTimeout(saveTimers.current[frameId]);
    saveTimers.current[frameId] = setTimeout(() => {
      setSavingFrameId(frameId);
      startTransition(async () => {
        const result = await saveShortConfigPatch(storyId, patch);
        if (!result.ok) {
          setError(result.error ?? "save failed");
        } else if (result.config) {
          onConfigChange(result.config);
        }
        setSavingFrameId(null);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  function onPromptChange(frameId: string, value: string) {
    setDraft((d) => ({ ...d, [frameId]: { ...d[frameId], imagePrompt: value } }));
    scheduleSave(frameId, {
      [`doodle_frames.${frameId}.image_prompt`]: value,
    });
  }

  function onAltChange(frameId: string, value: string) {
    setDraft((d) => ({ ...d, [frameId]: { ...d[frameId], alt: value } }));
    scheduleSave(frameId, {
      [`doodle_frames.${frameId}.alt`]: value,
    });
  }

  function onRegen(frameId: string) {
    setError(null);
    setPendingRegen(frameId);
    const prompt = draft[frameId]?.imagePrompt ?? "";
    startTransition(async () => {
      const result = await regenShortScene(storyId, frameId, prompt);
      if (!result.ok) {
        setError(result.error ?? "regen failed");
      } else {
        // The worker writes the new url on completion; refreshing here
        // surfaces the queued row in the panel's status column.
        router.refresh();
      }
      setPendingRegen(null);
    });
  }

  function onTogglePin(frame: ShortFrame) {
    const target = !frame.is_pinned;
    startTransition(async () => {
      const result = await setFrameIsPinned(storyId, frame.id, target);
      if (!result.ok) {
        setError(result.error ?? "pin failed");
        return;
      }
      onConfigChange({
        ...config,
        doodle_frames: config.doodle_frames.map((f) =>
          f.id === frame.id ? { ...f, is_pinned: target } : f,
        ),
      });
    });
  }

  function onRevert(frame: ShortFrame) {
    if (!frame.prev_image) return;
    if (
      !window.confirm(
        "Revert this scene to the prior image? The current image will be lost (no further undo).",
      )
    ) {
      return;
    }
    startTransition(async () => {
      const result = await revertShortScene(storyId, frame.id);
      if (!result.ok) {
        setError(result.error ?? "revert failed");
      } else {
        router.refresh();
      }
    });
  }

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted">
          Scenes ({frames.length})
        </h2>
        {initialRender && (
          <span className="font-mono text-[10px] text-muted">
            Last render: {initialRender.status}
          </span>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-warn bg-warn/10 px-3 py-2 text-[12px] text-warn"
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {frames.map((frame) => {
          const d = draft[frame.id] ?? { imagePrompt: "", alt: "" };
          const isSaving = savingFrameId === frame.id;
          const isRegenning = pendingRegen === frame.id && pending;
          return (
            <div
              key={frame.id}
              className="space-y-2 rounded-lg border border-line bg-surface p-3"
            >
              <div className="relative overflow-hidden rounded-md bg-bg">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={frame.url}
                  alt={frame.alt ?? `Scene ${frame.id}`}
                  loading="lazy"
                  className="aspect-[9/16] w-full object-cover"
                />
                {isRegenning && (
                  <div className="absolute inset-0 flex items-center justify-center bg-bg/70 font-mono text-[10px] uppercase tracking-wider text-muted">
                    Regenerating…
                  </div>
                )}
                {frame.is_pinned && (
                  <span className="absolute right-2 top-2 rounded-full bg-accent px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-bg">
                    Pinned
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-muted">
                <span>{frame.id}</span>
                <span>
                  {isSaving ? "saving…" : "·"}
                </span>
              </div>

              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                  Prompt
                </span>
                <textarea
                  value={d.imagePrompt}
                  onChange={(e) => onPromptChange(frame.id, e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
                  placeholder="Describe this scene (used by the per-scene regenerate)"
                />
              </label>

              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                  Alt
                </span>
                <input
                  value={d.alt}
                  onChange={(e) => onAltChange(frame.id, e.target.value)}
                  className="mt-1 w-full rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
                  placeholder="One short sentence for accessibility"
                />
              </label>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onRegen(frame.id)}
                  disabled={pending || !d.imagePrompt.trim()}
                  title="Regenerate this scene with the current prompt (~$0.05)"
                  className="rounded-md bg-accent px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Regenerate
                </button>
                <button
                  type="button"
                  onClick={() => onTogglePin(frame)}
                  disabled={pending}
                  title={
                    frame.is_pinned
                      ? "Unpin to allow a full Regenerate to overwrite this frame"
                      : "Pin to protect this frame from a future full Regenerate"
                  }
                  className="rounded-md border border-line bg-bg px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {frame.is_pinned ? "Unpin" : "Pin"}
                </button>
                {frame.prev_image && (
                  <button
                    type="button"
                    onClick={() => onRevert(frame)}
                    disabled={pending}
                    title="Restore the prior image (single-step undo)"
                    className="rounded-md border border-line bg-bg px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Revert
                  </button>
                )}
              </div>

              {linkedArticles.length > 0 ? (
                <div className="border-t border-line/60 pt-2">
                  <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-muted">
                    Use in article
                  </div>
                  <SceneArticleActions
                    storyId={storyId}
                    frameId={frame.id}
                    frameAlt={d.alt}
                    linkedArticles={linkedArticles}
                  />
                </div>
              ) : (
                <p className="border-t border-line/60 pt-2 font-mono text-[9px] uppercase tracking-wider text-muted">
                  Link an article to this story to promote scenes
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
