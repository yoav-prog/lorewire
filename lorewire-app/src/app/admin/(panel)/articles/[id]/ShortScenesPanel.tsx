"use client";

// Thumbnail grid of the article's linked short_render scenes, with three
// actions per frame: Set as hero, Set as OG image, Add to gallery. Renders
// only when the parent passes a non-null `frames` prop (the page already
// resolved the article -> story -> short_render -> frames chain via
// getLinkedShortFrames in lib/article-shorts.ts).
//
// Action semantics (chosen 2026-06-15):
//   - Direct replace: clicking "Set as hero" overwrites the existing
//     hero_image immediately. No confirm modal — rule 10, lazy user.
//   - Undo: each successful action surfaces a one-line banner at the top
//     of the panel: "Hero replaced. Undo." for ~10 s. The banner captures
//     the previous value the server returned and posts it back through the
//     matching revert action when Undo is clicked.
//   - Auto-dismiss: the banner disappears on timeout OR on the next action,
//     whichever comes first. We deliberately do NOT stack banners — a
//     stacking history is more confusing than helpful for one-click undo.
//
// Plan: _plans/2026-06-15-shorts-to-article-media.md

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addArticleGalleryImageFromFrameAction,
  revertArticleDocumentAction,
  revertArticleHeroAction,
  revertArticleOgAction,
  setArticleHeroFromFrameAction,
  setArticleOgFromFrameAction,
} from "@/app/admin/actions";

const UNDO_TIMEOUT_MS = 10_000;

const BTN =
  "rounded-md border border-line bg-bg px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40";

type ActionKind = "hero" | "og" | "gallery";

interface UndoState {
  kind: ActionKind;
  /** For hero / og: the previous URL string (or null when the field was
   *  empty before). For gallery: the full previous document JSON string. */
  previous: string | null;
  /** Timer handle so a new action can cancel the in-flight auto-dismiss. */
  timer: ReturnType<typeof setTimeout>;
}

export interface ShortSceneFrame {
  id: string;
  url: string;
  caption_chunk_start_index: number | null;
}

export interface ShortScenesPanelProps {
  articleId: string;
  storyId: string;
  storyTitle: string | null;
  shortRenderId: string;
  frames: ShortSceneFrame[];
}

export function ShortScenesPanel({
  articleId,
  storyId,
  storyTitle,
  shortRenderId,
  frames,
}: ShortScenesPanelProps) {
  const router = useRouter();
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [error, setError] = useState("");
  const [pendingFrameId, setPendingFrameId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    console.info("[article-editor scenes-loaded]", {
      articleId,
      storyId,
      shortRenderId,
      frameCount: frames.length,
    });
  }, [articleId, storyId, shortRenderId, frames.length]);

  useEffect(() => {
    // Cancel any pending undo on unmount so a stale timer doesn't fire on
    // an editor that's navigated away.
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    };
  }, []);

  function scheduleUndo(kind: ActionKind, previous: string | null): void {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    const timer = setTimeout(() => setUndo(null), UNDO_TIMEOUT_MS);
    undoTimerRef.current = timer;
    setUndo({ kind, previous, timer });
  }

  function clearUndo(): void {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = null;
    setUndo(null);
  }

  function applyFrame(frameId: string, action: ActionKind): void {
    setError("");
    setPendingFrameId(frameId);
    const formData = new FormData();
    formData.set("id", articleId);
    formData.set("frame_id", frameId);
    startTransition(async () => {
      console.info("[article-editor apply-frame]", {
        articleId,
        frameId,
        action,
      });
      try {
        if (action === "hero") {
          const result = await setArticleHeroFromFrameAction(formData);
          if (!result.ok) {
            setError(result.error ?? "unknown");
            return;
          }
          scheduleUndo("hero", result.previousUrl ?? null);
        } else if (action === "og") {
          const result = await setArticleOgFromFrameAction(formData);
          if (!result.ok) {
            setError(result.error ?? "unknown");
            return;
          }
          scheduleUndo("og", result.previousUrl ?? null);
        } else {
          const result = await addArticleGalleryImageFromFrameAction(formData);
          if (!result.ok) {
            setError(result.error ?? "unknown");
            return;
          }
          scheduleUndo("gallery", result.previousDocument ?? null);
        }
        router.refresh();
      } finally {
        setPendingFrameId(null);
      }
    });
  }

  function doUndo(): void {
    if (!undo) return;
    const kind = undo.kind;
    const previous = undo.previous;
    clearUndo();
    const formData = new FormData();
    formData.set("id", articleId);
    startTransition(async () => {
      console.info("[article-editor undo]", { articleId, action: kind });
      let result: { ok: boolean; error?: string };
      if (kind === "hero") {
        if (previous !== null) formData.set("previous_url", previous);
        result = await revertArticleHeroAction(formData);
      } else if (kind === "og") {
        if (previous !== null) formData.set("previous_url", previous);
        result = await revertArticleOgAction(formData);
      } else {
        // Gallery revert needs a full document. Capture is null only when
        // an admin somehow promoted to gallery against an article with no
        // document, which the action refuses up front — so this branch is
        // defensive and the user sees the error if it ever fires.
        if (previous === null) {
          setError("No previous document captured for undo.");
          return;
        }
        formData.set("previous_document", previous);
        result = await revertArticleDocumentAction(formData);
      }
      if (!result.ok) {
        setError(result.error ?? "unknown");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted">
          Scenes from short
        </span>
        <span className="flex-1 truncate text-[12px] text-muted">
          {storyTitle ?? "(linked story title unavailable)"} · {frames.length}{" "}
          frame{frames.length === 1 ? "" : "s"}
        </span>
      </div>

      {undo && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-md border border-accent bg-accent/10 px-3 py-2 text-[12px] text-ink"
        >
          <span className="flex-1">
            {undo.kind === "hero" && "Hero image replaced."}
            {undo.kind === "og" && "OG image replaced."}
            {undo.kind === "gallery" && "Added to gallery."}
          </span>
          <button
            type="button"
            onClick={doUndo}
            disabled={pending}
            className={BTN}
          >
            Undo
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md border border-warn bg-warn/10 px-3 py-2 text-[12px] text-warn"
        >
          Action failed: {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {frames.map((frame) => {
          const isPending = pendingFrameId === frame.id && pending;
          return (
            <div
              key={frame.id}
              className="space-y-1 rounded-md border border-line bg-bg p-2"
            >
              <div className="relative overflow-hidden rounded-sm bg-surface">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={frame.url}
                  alt={`Scene ${frame.id}`}
                  loading="lazy"
                  className="aspect-[9/16] h-auto w-full object-cover"
                />
                {isPending && (
                  <div className="absolute inset-0 flex items-center justify-center bg-bg/70 text-[11px] text-muted">
                    Working…
                  </div>
                )}
              </div>
              <div className="font-mono text-[10px] text-muted">{frame.id}</div>
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  className={BTN}
                  disabled={pending}
                  onClick={() => applyFrame(frame.id, "hero")}
                >
                  Hero
                </button>
                <button
                  type="button"
                  className={BTN}
                  disabled={pending}
                  onClick={() => applyFrame(frame.id, "og")}
                >
                  OG
                </button>
                <button
                  type="button"
                  className={BTN}
                  disabled={pending}
                  onClick={() => applyFrame(frame.id, "gallery")}
                >
                  Gallery
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
