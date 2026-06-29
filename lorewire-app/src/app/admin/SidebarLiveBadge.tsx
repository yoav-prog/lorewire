"use client";

// Sidebar dot+count for /admin/reddit-sources/live. Polls every 15s
// (lower cadence than the live page itself, because this is a passive
// glanceable indicator across every admin screen) and pauses when the
// tab is hidden. Renders nothing when the count is zero so the sidebar
// stays clean.
//
// The action returns only an integer; nothing payload-shaped crosses
// the network. The capability check inside the action means an
// unauthenticated probe throws before the count is computed.
//
// Plan: _plans/2026-06-28-reddit-sources-live-runs-page.md.

import { useEffect, useState } from "react";
import { countActiveStoryJobsAction } from "@/app/admin/actions";

const POLL_MS = 15_000;

export default function SidebarLiveBadge() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function tick() {
      try {
        const n = await countActiveStoryJobsAction();
        if (cancelled) return;
        setCount(n);
        console.info("[sidebar live badge poll]", { count: n });
      } catch (e) {
        if (cancelled) return;
        console.warn("[sidebar live badge poll error]", {
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
      aria-label={`${count} active runs`}
      title={`${count} active run${count === 1 ? "" : "s"}`}
      className="ml-auto inline-flex items-center gap-1 rounded-full bg-accent/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wider text-accent"
    >
      <span
        aria-hidden="true"
        className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
      />
      {count}
    </span>
  );
}
