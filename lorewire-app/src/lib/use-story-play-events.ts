// 2026-06-25 Phase 1 of _plans/2026-06-25-top10-ranking.md. Wires
// play_started + play_completed emitters onto a <video> element. The
// emitters dedupe per (storyId, mount) so a re-watch within the same
// modal session doesn't double-count; closing and re-opening the modal
// remounts the hook and a fresh play is countable again. play_completed
// fires when the user crosses the 90% threshold for the first time.
//
// Both shells (Desktop + Mobile) consume the same hook so the signal
// stays consistent across breakpoints.

"use client";

import { useCallback, useEffect, useRef } from "react";

const COMPLETION_THRESHOLD = 0.9;

export interface StoryPlayEventHandlers {
  onPlay: () => void;
  onTimeUpdate: (e: React.SyntheticEvent<HTMLVideoElement>) => void;
}

export function useStoryPlayEvents(storyId: string): StoryPlayEventHandlers {
  // Track which story we've already counted so a re-watch (replay,
  // seek-back-then-play) doesn't fire a second event. Reset whenever
  // the underlying story changes — the modal stays mounted but the
  // story can swap when the user navigates between stories.
  const startedFor = useRef<string | null>(null);
  const completedFor = useRef<string | null>(null);
  useEffect(() => {
    startedFor.current = null;
    completedFor.current = null;
  }, [storyId]);

  const onPlay = useCallback(() => {
    if (startedFor.current === storyId) return;
    startedFor.current = storyId;
    // eslint-disable-next-line no-console -- rule 14
    console.info("[lorewire event emit]", { story_id: storyId, type: "play_started" });
    import("@/app/actions")
      .then((m) => m.recordStoryEventAction(storyId, "play_started"))
      .catch(() => {
        /* event emit is best-effort; UI doesn't care */
      });
  }, [storyId]);

  const onTimeUpdate = useCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => {
      if (completedFor.current === storyId) return;
      const v = e.currentTarget;
      const dur = v.duration;
      if (!Number.isFinite(dur) || dur <= 0) return;
      if (v.currentTime / dur < COMPLETION_THRESHOLD) return;
      completedFor.current = storyId;
      // eslint-disable-next-line no-console -- rule 14
      console.info("[lorewire event emit]", {
        story_id: storyId,
        type: "play_completed",
        position_pct: Math.round((v.currentTime / dur) * 100),
      });
      import("@/app/actions")
        .then((m) => m.recordStoryEventAction(storyId, "play_completed"))
        .catch(() => {
          /* event emit is best-effort */
        });
    },
    [storyId],
  );

  return { onPlay, onTimeUpdate };
}
