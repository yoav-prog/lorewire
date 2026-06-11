"use client";

// Auto-refresh the segments page every 5 seconds while at least one row is in
// a transitional state (pending / uploading / normalizing). The pipeline
// worker polls at the same cadence (default 5s), so a freshly uploaded
// segment flips to "Ready" within one refresh of the worker picking it up.
// Stops polling once the rows quiesce — no idle network chatter.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 5000;

export function SegmentsAutoRefresh({ activeRows }: { activeRows: number }) {
  const router = useRouter();
  useEffect(() => {
    if (activeRows <= 0) return;
    const id = setInterval(() => {
      router.refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [activeRows, router]);
  return null;
}
