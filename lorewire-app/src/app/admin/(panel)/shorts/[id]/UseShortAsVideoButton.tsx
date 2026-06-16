"use client";

// "Use this short as the story's video" footer button. Wraps the
// applyLatestShortToStoryAction server action, which points the
// stories.video_url at the latest done short_render's output_url.
// Reversible: the long-form MP4 lives at a separate GCS key, so
// re-rendering the long-form video restores it.
//
// After a successful apply the button surfaces the slug-linked "View
// story" so the admin can verify the live page renders the short — the
// previous version stopped at "Applied ✓" with no verification path,
// which made silent no-op writes hard to notice.
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
  const [appliedSlug, setAppliedSlug] = useState<string | null>(null);
  const [appliedUrl, setAppliedUrl] = useState<string | null>(null);
  const applied = appliedUrl !== null;
  const [pending, startTransition] = useTransition();

  function apply() {
    setError(null);
    setAppliedSlug(null);
    setAppliedUrl(null);
    startTransition(async () => {
      const r = await applyLatestShortToStoryAction(storyId);
      // eslint-disable-next-line no-console -- rule 14
      console.info("[short editor apply-button result]", {
        story_id: storyId,
        ok: r.ok,
        error: r.error ?? null,
        url: r.url ?? null,
        slug: r.slug ?? null,
      });
      if (!r.ok) {
        setError(r.error ?? "apply failed");
        return;
      }
      setAppliedUrl(r.url ?? null);
      setAppliedSlug(r.slug ?? null);
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
        {applied && (
          <p className="mt-1 break-all font-mono text-[10px] text-muted">
            video_url ← <span className="text-ink">{appliedUrl}</span>
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {applied && appliedSlug && (
          <a
            href={`/v/${appliedSlug}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-accent transition-colors hover:bg-accent/10"
          >
            View story ↗
          </a>
        )}
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
              ? "Re-apply latest"
              : "Use as story video"}
        </button>
      </div>
      {error && (
        <span className="basis-full font-mono text-[10px] text-warn">
          {error}
        </span>
      )}
    </div>
  );
}
