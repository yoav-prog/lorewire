"use client";

// Sidebar unread-count badge for /admin/notifications. Polls every 15s (a
// passive, glanceable indicator across every admin screen) and pauses when
// the tab is hidden. Renders nothing when the count is zero so the sidebar
// stays clean. Red, because an unread notification is a failure someone
// must act on. Mirrors SidebarSubmissionsBadge / SidebarLiveBadge. The
// action returns only an integer; the capability check inside it means an
// unauthenticated probe throws before any count.
//
// Plan: _plans/2026-07-02-never-publish-without-video.md.

import { useEffect, useState } from "react";
import { countUnreadAdminNotificationsAction } from "@/app/admin/actions";

const POLL_MS = 15_000;

export default function SidebarNotificationsBadge() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function tick() {
      try {
        const n = await countUnreadAdminNotificationsAction();
        if (cancelled) return;
        setCount(n);
      } catch (e) {
        if (cancelled) return;
        console.warn("[sidebar notifications badge poll error]", {
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }

    function start() {
      if (timer != null) return;
      timer = setInterval(() => void tick(), POLL_MS);
    }
    function stop() {
      if (timer == null) return;
      clearInterval(timer);
      timer = null;
    }
    function onVisibility() {
      if (document.visibilityState === "visible") {
        void tick();
        start();
      } else {
        stop();
      }
    }

    if (document.visibilityState === "visible") {
      void tick();
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  if (!count || count <= 0) return null;

  return (
    <span
      aria-label={`${count} unread notification${count === 1 ? "" : "s"}`}
      title={`${count} unread notification${count === 1 ? "" : "s"}`}
      className="ml-auto inline-flex items-center rounded-full bg-danger/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wider text-danger"
    >
      {count}
    </span>
  );
}
