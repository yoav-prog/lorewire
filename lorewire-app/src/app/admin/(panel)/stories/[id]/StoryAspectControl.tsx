"use client";

// Per-story aspect picker. Phase 4 of
// _plans/2026-06-12-video-aspect-ratio.md.
//
// The chip group shows the resolved aspect (from `video_config.aspect`,
// the global default, or the legacy 9:16 floor) and writes through
// `setStoryAspectAction` on every change. Optimistic: the chip flips
// immediately and `useTransition` runs the server action in the
// background. On failure the action returns `{ok: false}` and we revert
// the local state.
//
// Lives next to CategoryChipGroup / StatusStepIndicator in the same
// folder so the story edit page imports everything from one neighbourhood.

import { useState, useTransition } from "react";
import { setStoryAspectAction } from "@/app/admin/actions";
import { AspectChipGroup } from "@/components/ui";
import { isVideoAspect, type VideoAspect } from "@/lib/aspect";

export function StoryAspectControl({
  storyId,
  initialAspect,
  globalDefault,
}: {
  storyId: string;
  /** What `resolveAspect` gave us on the server. */
  initialAspect: VideoAspect;
  /** Whether the initial value came from the per-story override (true)
   *  or from the global default / legacy fallback (false). */
  globalDefault: boolean;
}) {
  const [value, setValue] = useState<VideoAspect>(initialAspect);
  const [overridden, setOverridden] = useState(!globalDefault);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function flip(next: VideoAspect) {
    const prev = value;
    setValue(next);
    setOverridden(true);
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("id", storyId);
      fd.set("aspect", next);
      const r = await setStoryAspectAction(fd);
      if (!r.ok) {
        setValue(prev);
        setError(r.error ?? "Save failed");
      } else if (typeof window !== "undefined") {
        console.info("[admin ui] story aspect set", { storyId, aspect: next });
      }
    });
  }

  return (
    <div className="space-y-1.5" data-testid="story-aspect-control">
      <AspectChipGroup
        value={isVideoAspect(value) ? value : initialAspect}
        onChange={flip}
        ariaLabel="Story aspect ratio"
        disabled={isPending}
      />
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
        {overridden
          ? "Per-story override"
          : "Inheriting global default — pick to override"}
        {isPending ? " · saving…" : ""}
        {error ? ` · ${error}` : ""}
      </p>
    </div>
  );
}
