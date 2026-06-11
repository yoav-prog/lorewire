"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Polls the route while any image_renders row for this owner is in a
// transitional state (queued / generating). Mirrors the segments-page
// pattern. Stops polling as soon as everything settles to done/error so
// idle pages don't burn cycles or DB reads.
//
// Pass `activeRows` from the server component (computed by counting
// transitional rows for this owner). When it drops to 0, the effect
// returns early and stays quiet until a fresh server render hands it a
// non-zero count.

const POLL_MS = 3_000;

export function RegenAutoRefresh({ activeRows }: { activeRows: number }) {
  const router = useRouter();
  useEffect(() => {
    if (activeRows <= 0) return;
    const t = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [activeRows, router]);
  return null;
}
