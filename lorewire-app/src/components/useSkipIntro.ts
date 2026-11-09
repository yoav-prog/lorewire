"use client";

// Shared player logic for the Skip Intro feature (Wires cards + the story-page
// video). Given a server-resolved intro window, this hook decides when the
// "Skip intro" button is on screen and when the "Always skip intro" pref may
// auto-seek — the two surfaces just wire its handlers into their <video>
// events and render the button off `showSkip`.
//
// Behavior contract (plan: _plans/2026-07-04-skip-intro.md):
//   - The button shows exactly while playback sits inside the window.
//   - Auto-skip fires on entering the window (including starting inside it —
//     the legacy intro-first rows begin at 0), at most until playback leaves.
//   - A USER seek that lands inside the window suppresses auto-skip until
//     playback leaves the window — scrubbing into the intro is an explicit
//     choice to watch it. The seek target of our own skip is the window's
//     end, which is outside it, so programmatic skips never self-suppress.
//   - Restarts (loop wrap, replay, card re-activation) re-arm everything.
//   - Every decision is belt-and-braced against the element's REAL duration
//     via introWindowUsable, so a stale window can never seek past the end.

import { useCallback, useRef, useState } from "react";
import {
  introWindowUsable,
  isInIntroWindow,
  type IntroWindow,
} from "@/lib/intro-window";

/** Backward jumps larger than this read as a restart (loop wrap / replay),
 *  not seek jitter — re-arm the auto-skip and clear any suppression. */
const RESTART_JUMP_MS = 500;

export interface UseSkipIntroArgs {
  /** Server-resolved intro window; null → the hook is inert. */
  introWindow: IntroWindow | null;
  /** The "Always skip intro" pref (useWirePrefs().skipIntro). */
  autoSkip: boolean;
  /** Log namespace per rule 14, e.g. "wires skip-intro". */
  logNs: string;
  /** Story id for the logs. */
  id: string;
}

export interface UseSkipIntroResult {
  /** Render the "Skip intro" button while true. */
  showSkip: boolean;
  /** The button's onClick — seeks to the end of the window. */
  skipNow: (v: HTMLVideoElement | null) => void;
  /** Wire into the video's onTimeUpdate. */
  handleTimeUpdate: (v: HTMLVideoElement) => void;
  /** Wire into onLoadedMetadata: when the intro opens the video (the legacy
   *  intro-first rows) and the pref is on, seek before the first frame paints
   *  instead of flashing the intro for one timeupdate tick. */
  handleLoadedMetadata: (v: HTMLVideoElement) => void;
  /** Call from USER-driven seek paths (scrubber drags, arrow keys, native
   *  controls' onSeeking) with the seek target in ms. */
  notifyManualSeek: (targetMs: number) => void;
  /** Clear per-playthrough state (card deactivation / video swap). */
  reset: () => void;
}

function durationMs(v: HTMLVideoElement): number | null {
  return Number.isFinite(v.duration) && v.duration > 0
    ? v.duration * 1000
    : null;
}

export function useSkipIntro({
  introWindow,
  autoSkip,
  logNs,
  id,
}: UseSkipIntroArgs): UseSkipIntroResult {
  const [showSkip, setShowSkip] = useState(false);
  // Refs, not state: these change on every timeupdate tick and must never
  // re-render the player.
  const lastTMsRef = useRef(0);
  const suppressedRef = useRef(false);

  const skip = useCallback(
    (v: HTMLVideoElement, reason: "button" | "auto") => {
      if (!introWindowUsable(introWindow, durationMs(v))) return;
      const fromMs = Math.round(v.currentTime * 1000);
      try {
        v.currentTime = introWindow.end_ms / 1000;
      } catch {
        // Not seekable yet — the next timeupdate retries (bounded by the
        // window itself: once playback passes end_ms nothing fires).
        return;
      }
      lastTMsRef.current = introWindow.end_ms;
      setShowSkip(false);
      console.info(`[${logNs}] skipped`, {
        id,
        reason,
        from_ms: fromMs,
        to_ms: introWindow.end_ms,
      });
    },
    [introWindow, logNs, id],
  );

  const skipNow = useCallback(
    (v: HTMLVideoElement | null) => {
      if (v) skip(v, "button");
    },
    [skip],
  );

  const handleTimeUpdate = useCallback(
    (v: HTMLVideoElement) => {
      if (!introWindowUsable(introWindow, durationMs(v))) {
        if (showSkip) setShowSkip(false);
        return;
      }
      const tMs = v.currentTime * 1000;
      const lastMs = lastTMsRef.current;
      lastTMsRef.current = tMs;
      if (tMs + RESTART_JUMP_MS < lastMs) {
        // Loop wrap / replay — this playthrough starts fresh.
        suppressedRef.current = false;
      }
      const inWindow = isInIntroWindow(tMs, introWindow);
      if (inWindow !== showSkip) setShowSkip(inWindow);
      if (!inWindow) {
        // Once playback moves past the intro on its own, any manual-seek
        // suppression has served its purpose.
        if (tMs >= introWindow.end_ms) suppressedRef.current = false;
        return;
      }
      if (autoSkip && !suppressedRef.current) skip(v, "auto");
    },
    [introWindow, autoSkip, showSkip, skip],
  );

  const handleLoadedMetadata = useCallback(
    (v: HTMLVideoElement) => {
      if (!autoSkip) return;
      if (!introWindowUsable(introWindow, durationMs(v))) return;
      if (introWindow.start_ms !== 0) return; // hook-first — the hook must play
      if (v.currentTime * 1000 >= introWindow.end_ms) return;
      skip(v, "auto");
    },
    [introWindow, autoSkip, skip],
  );

  const notifyManualSeek = useCallback(
    (targetMs: number) => {
      // Keep the restart detector honest across user seeks.
      lastTMsRef.current = targetMs;
      if (!introWindow) return;
      const intoWindow = isInIntroWindow(targetMs, introWindow);
      suppressedRef.current = intoWindow;
      if (intoWindow) {
        console.info(`[${logNs}] auto-skip suppressed by manual seek`, {
          id,
          target_ms: Math.round(targetMs),
        });
      }
    },
    [introWindow, logNs, id],
  );

  const reset = useCallback(() => {
    lastTMsRef.current = 0;
    suppressedRef.current = false;
    setShowSkip(false);
  }, []);

  return {
    showSkip,
    skipNow,
    handleTimeUpdate,
    handleLoadedMetadata,
    notifyManualSeek,
    reset,
  };
}
