"use client";

import { useEffect } from "react";

// Registers the service worker (production only, to avoid caching dev/HMR assets).
export default function RegisterSW() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* registration is best-effort; the app works without it */
    });
  }, []);
  return null;
}
