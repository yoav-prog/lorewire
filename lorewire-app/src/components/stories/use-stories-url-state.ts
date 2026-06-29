"use client";

// `?wire=<id>` URL state for the Stories viewer.
//
// Why `?wire=` and NOT `?story=`: the homepage already uses `?story=`
// for the Comments deep-link (src/app/page.tsx + AppShell's mobile
// shell), which opens the DetailModal at the Watch / Read / Comments
// tab. Reusing that param would either (a) open both the DetailModal
// AND the Stories viewer for the same id, or (b) make us re-route
// `?story=` to one of them, breaking the existing share links.
// `?wire=` is a clean separate slot.
//
// History strategy: openWire / closeWire use `history.replaceState` so
// the back stack stays clean (a session of tap-through inside the
// viewer doesn't create N back-stack entries). A user who explicitly
// wants a permalink uses the in-viewer Share button, which copies the
// canonical URL with the `?wire=<id>` param.

import { useCallback, useEffect, useState } from "react";

const PARAM = "wire";

export interface UseStoriesUrlState {
  /** Currently-active wire id from `?wire=<id>`, or null. */
  openWireId: string | null;
  /** Open the viewer at a wire and push `?wire=<id>` into the URL. */
  openWire: (id: string) => void;
  /** Close the viewer and remove `?wire=` from the URL. */
  closeWire: () => void;
}

function readParam(): string | null {
  if (typeof window === "undefined") return null;
  const sp = new URLSearchParams(window.location.search);
  const raw = sp.get(PARAM)?.trim();
  return raw ? raw : null;
}

function writeParam(value: string | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (value === null) {
    url.searchParams.delete(PARAM);
  } else {
    url.searchParams.set(PARAM, value);
  }
  // replaceState keeps the back stack clean — a session of N tap-throughs
  // inside the viewer creates 0 history entries instead of N.
  window.history.replaceState(window.history.state, "", url.toString());
}

export function useStoriesUrlState(): UseStoriesUrlState {
  const [openWireId, setOpenWireId] = useState<string | null>(null);

  // Initialize from the URL on mount and listen for back/forward.
  useEffect(() => {
    setOpenWireId(readParam());
    const onPop = () => setOpenWireId(readParam());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openWire = useCallback((id: string) => {
    if (!id) return;
    writeParam(id);
    setOpenWireId(id);
    // eslint-disable-next-line no-console -- rule 14
    console.info("[stories url open]", { wire_id: id });
  }, []);

  const closeWire = useCallback(() => {
    writeParam(null);
    setOpenWireId(null);
    // eslint-disable-next-line no-console -- rule 14
    console.info("[stories url close]", {});
  }, []);

  return { openWireId, openWire, closeWire };
}
