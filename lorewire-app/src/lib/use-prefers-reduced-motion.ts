// prefers-reduced-motion as an external store — the React-19-sanctioned way to
// read a browser media query without setting state inside an effect. Returns
// false during SSR so the first client paint matches the server. Shared by the
// mobile (ReelsFeed) and desktop (ReelsDesktop) reels surfaces.

import { useSyncExternalStore } from "react";

const RM_QUERY = "(prefers-reduced-motion: reduce)";

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mq = window.matchMedia(RM_QUERY);
      mq.addEventListener("change", notify);
      return () => mq.removeEventListener("change", notify);
    },
    () =>
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia(RM_QUERY).matches
        : false,
    () => false,
  );
}
