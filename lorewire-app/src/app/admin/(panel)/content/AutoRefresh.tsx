"use client";

// 2026-06-25 Content list auto-refresh. Mounted by ContentList when there's at
// least one loaded row with an in-flight render (progress != null), so the
// operator can watch a short / image / voice render tick up without manual
// reloads. 2026-07-15 (Phase 1): the list is now client-paginated, so a
// router.refresh() no longer re-fetches it — instead this calls `onTick`, the
// pager's in-place refresh(), which re-fetches the loaded window without
// resetting the cursor, selection, or scroll.
//
// Stops the timer:
//   - on tab background (visibilitychange to hidden) — no point
//     refreshing what nobody's watching, and it avoids a thundering
//     herd if the operator leaves the page open overnight
//   - on unmount (progress-clears-on-next-tick remount with the parent
//     omitting the component)
//
// Whether to mount at all is decided by ContentList, based on whether any
// loaded row has progress != null — a no-active-render list is a zero-cost
// no-op (component never renders).

import { useEffect } from "react";

const REFRESH_MS = 20_000;

export function AutoRefresh({
  onTick,
  intervalMs = REFRESH_MS,
}: {
  /** Called on each interval — the pager's in-place refresh(). */
  onTick: () => void;
  intervalMs?: number;
}) {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    function start() {
      if (timer != null) return;
      timer = setInterval(() => {
        console.info("[content list auto-refresh tick]");
        onTick();
      }, intervalMs);
    }
    function stop() {
      if (timer == null) return;
      clearInterval(timer);
      timer = null;
    }
    function onVisibility() {
      if (document.visibilityState === "visible") start();
      else stop();
    }
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, onTick]);
  return null;
}
