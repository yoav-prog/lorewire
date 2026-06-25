"use client";

// 2026-06-25 Content list auto-refresh. Mounted by /admin/content when
// there's at least one row with an in-flight render (progress != null),
// so the operator can watch a short / image / voice render tick up
// without manual page reloads. Uses router.refresh() rather than a
// full reload so React state (search box value, selection, scroll
// position) survives the cycle.
//
// Stops the timer:
//   - on tab background (visibilitychange to hidden) — no point
//     refreshing what nobody's watching, and it avoids a thundering
//     herd if the operator leaves the page open overnight
//   - on unmount (route change / progress-clears-on-next-tick remount
//     with the prop omitted)
//
// The interval lives on the client. The decision of WHETHER to mount
// at all is server-side, based on whether any visible row has
// progress != null. So a no-active-render page is a zero-cost
// no-op (component never renders).

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const REFRESH_MS = 20_000;

export function AutoRefresh({
  intervalMs = REFRESH_MS,
}: {
  intervalMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    function start() {
      if (timer != null) return;
      timer = setInterval(() => {
         
        console.info("[content list auto-refresh tick]");
        router.refresh();
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
  }, [intervalMs, router]);
  return null;
}
