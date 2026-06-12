"use client";

// Per-frame Regenerate + Revert actions for the video editor's
// storyboard rail. Rendered inside FrameCard when the frame is
// selected. Mirrors the pattern in
// app/admin/(panel)/_components/RegenButton.tsx (useTransition →
// server action → router.refresh on success) so the editor's rail
// feels consistent with the rest of the admin's regen surfaces.
//
// Phase 3 of the video editor overhaul
// (_plans/2026-06-12-video-editor-overhaul.md). Phase 4 layers the
// running session-spend + bulk-confirm modal on top of this. Phase 4
// also splits this into "view prompt" vs "edit prompt" modes — for now
// the textarea is always editable so the user can actually try a regen
// on the existing data (which has no persisted image_prompt yet).

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ImageRenderRow } from "@/lib/image-render-queue";
import {
  queueFrameImageRegen,
  revertFrameImage,
  type FrameRegenResult,
  type FrameRevertResult,
} from "./actions";

const TRANSITIONAL_STATUSES = new Set(["queued", "generating"]);

export interface FrameRegenActionsProps {
  storyId: string;
  frameId: string;
  /** Pre-fetched latest IMAGE_RENDERS row for this frame, or null. */
  latestRender: ImageRenderRow | null;
  /** Pre-computed estimate from the server. */
  estimateCents: number;
  /** Current image_prompt on the frame, if any. Pre-fills the textarea. */
  currentPrompt: string;
  /** True when the frame has a prev_image (i.e. Revert would do something). */
  canRevert: boolean;
  /** False when this editor is in a foreign-owned session — buttons
   *  rendered but disabled with a clear hint. */
  enabled: boolean;
}

export function FrameRegenActions({
  storyId,
  frameId,
  latestRender,
  estimateCents,
  currentPrompt,
  canRevert,
  enabled,
}: FrameRegenActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draftPrompt, setDraftPrompt] = useState(currentPrompt);
  const [regenResult, setRegenResult] = useState<FrameRegenResult | null>(null);
  const [revertResult, setRevertResult] = useState<FrameRevertResult | null>(
    null,
  );

  // True while a queue row for this exact frame is queued or generating.
  // Surfaces as a status pill and disables both buttons so the admin
  // can't double-charge by mashing the button.
  const transitional =
    latestRender !== null && TRANSITIONAL_STATUSES.has(latestRender.status);

  const promptDirty = draftPrompt.trim() !== currentPrompt.trim();

  function fireRegen() {
    if (!enabled || pending || transitional) return;
    startTransition(async () => {
      // Only send the prompt if the user actually changed it — otherwise
      // the action falls back to the persisted prompt (or scene prompt)
      // which keeps the prompt-source attribution correct in logs.
      const payload = promptDirty ? draftPrompt.trim() : undefined;
      const r = await queueFrameImageRegen(storyId, frameId, payload);
      setRegenResult(r);
      setRevertResult(null);
      if (r.ok) router.refresh();
    });
  }

  function fireRevert() {
    if (!enabled || pending || transitional || !canRevert) return;
    startTransition(async () => {
      const r = await revertFrameImage(storyId, frameId);
      setRevertResult(r);
      setRegenResult(null);
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label
            htmlFor={`frame-prompt-${frameId}`}
            className="font-mono text-[10px] uppercase tracking-wider text-muted"
          >
            Prompt
          </label>
          {transitional && (
            <span className="rounded-full border border-warn/40 bg-warn/15 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-warn">
              {latestRender?.status === "queued" ? "Queued" : "Generating"}
            </span>
          )}
          {latestRender?.status === "error" && !transitional && (
            <span className="rounded-full border border-danger/40 bg-danger/15 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-danger">
              Failed
            </span>
          )}
        </div>
        <textarea
          id={`frame-prompt-${frameId}`}
          value={draftPrompt}
          onChange={(e) => setDraftPrompt(e.target.value)}
          disabled={!enabled || transitional || pending}
          placeholder={
            currentPrompt
              ? ""
              : "No prompt captured yet. Type one and Regenerate."
          }
          className="block w-full resize-y rounded-md border border-line bg-bg p-2 text-[12px] text-ink placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60"
          rows={3}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="rounded-full border border-line bg-surface2 px-2 py-0.5 font-mono text-[10px] text-muted">
          ≈ {formatCents(estimateCents)}
        </span>
        <div className="flex items-center gap-2">
          {canRevert && (
            <button
              type="button"
              onClick={fireRevert}
              disabled={!enabled || pending || transitional}
              className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink transition-colors hover:border-ink disabled:opacity-50"
            >
              {pending && revertResult === null ? "Reverting…" : "Revert"}
            </button>
          )}
          <button
            type="button"
            onClick={fireRegen}
            disabled={!enabled || pending || transitional}
            className="rounded-md bg-accent px-3 py-1 text-[12px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending && regenResult === null ? "Enqueuing…" : "Regenerate"}
          </button>
        </div>
      </div>

      {regenResult && !regenResult.ok && (
        <p className="text-[11px] text-danger">{explainRegenError(regenResult)}</p>
      )}
      {regenResult?.ok && regenResult.idempotentHit && (
        <p className="font-mono text-[10px] text-muted">
          Already queued — reusing the in-flight render.
        </p>
      )}
      {regenResult?.ok && !regenResult.idempotentHit && (
        <p className="font-mono text-[10px] text-muted">
          Queued. The worker will swap the image when it lands.
        </p>
      )}
      {revertResult && !revertResult.ok && (
        <p className="text-[11px] text-danger">
          {explainRevertError(revertResult)}
        </p>
      )}
      {revertResult?.ok && (
        <p className="font-mono text-[10px] text-muted">
          Reverted to the previous image.
        </p>
      )}
      {!enabled && (
        <p className="font-mono text-[10px] text-muted">
          Read-only — another admin owns the editor session.
        </p>
      )}
    </div>
  );
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function explainRegenError(r: FrameRegenResult): string {
  switch (r.error) {
    case "session-stolen":
      return "Another admin claimed the editor. Refresh to take it back.";
    case "no-session":
      return "Editor session expired. Refresh the page.";
    case "budget-exceeded":
      return "Daily image budget exceeded. Try later or raise the cap in Settings.";
    case "session-cap-exceeded": {
      const spent = r.sessionSpentCents ?? 0;
      const cap = r.sessionCapCents ?? 0;
      const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
      return `Session spend cap reached (${fmt(spent)} of ${fmt(cap)}). Raise it in Settings → Video editor, or wait.`;
    }
    case "frame-not-found":
      return "Frame not found — the editor may be out of sync. Refresh.";
    case "no-prompt-available":
      return "No prompt to regenerate with. Type one in the box above.";
    case "prompt-empty":
      return "Prompt is empty.";
    case "prompt-too-long":
      return "Prompt is too long (max 2000 chars).";
    case "prompt-control-chars":
      return "Prompt has illegal characters (tab + newline only).";
    case "config-invalid":
      return "Internal: persisted config rejected. Check console for details.";
    case "story-not-found":
      return "Story not found.";
    default:
      return r.error ?? "Regenerate failed.";
  }
}

function explainRevertError(r: FrameRevertResult): string {
  switch (r.error) {
    case "no-snapshot":
      return "Nothing to revert to.";
    case "session-stolen":
      return "Another admin claimed the editor. Refresh to take it back.";
    case "no-session":
      return "Editor session expired. Refresh the page.";
    case "frame-not-found":
      return "Frame not found.";
    case "config-invalid":
      return "Internal: revert produced an invalid config.";
    case "story-not-found":
      return "Story not found.";
    default:
      return r.error ?? "Revert failed.";
  }
}
