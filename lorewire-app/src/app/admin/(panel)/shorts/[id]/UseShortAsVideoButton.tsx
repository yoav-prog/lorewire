"use client";

// "Use this short as the story's video" footer button. Wraps the
// applyLatestShortToStoryAction server action, which points the
// stories.video_url at the latest done short_render's output_url.
// Reversible: the long-form MP4 lives at a separate GCS key, so
// re-rendering the long-form video restores it.
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md (Phase 5+ surfacing).

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyLatestShortToStoryAction } from "./actions";

export function UseShortAsVideoButton({
  storyId,
  disabled,
}: {
  storyId: string;
  /** True when no done short exists yet — render the button but disable
   *  so the affordance is discoverable + the tooltip explains why. */
  disabled: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [pending, startTransition] = useTransition();

  function apply() {
    setError(null);
    setApplied(false);
    startTransition(async () => {
      const r = await applyLatestShortToStoryAction(storyId);
      if (!r.ok) {
        setError(r.error ?? "apply failed");
        return;
      }
      setApplied(true);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface p-3">
      <div className="flex-1 text-[12px] text-ink">
        <p className="font-medium">Use this short as the story&apos;s video</p>
        <p className="mt-0.5 text-[11px] text-muted">
          Replaces the story&apos;s video URL with the latest finished short.
          Reversible: re-render the long-form video to switch back.
        </p>
      </div>
      <button
        type="button"
        onClick={apply}
        disabled={pending || disabled}
        title={disabled ? "Generate a short first" : undefined}
        className="rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending
          ? "Applying…"
          : applied
            ? "Applied ✓"
            : "Use as story video"}
      </button>
      {error && (
        <span className="font-mono text-[10px] text-warn">{error}</span>
      )}
    </div>
  );
}
