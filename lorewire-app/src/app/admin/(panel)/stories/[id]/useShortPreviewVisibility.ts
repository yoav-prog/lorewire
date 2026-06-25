"use client";

// Cross-component preview-visibility state for the unified story editor.
// The Action Bar's "👁 Preview" toggle chip and the StoryShortTabsClient
// (which renders the inline ShortPreviewPlayer) live in separate
// component trees, so we bridge them through localStorage + a custom
// event so a single toggle click updates both in the same tick.
//
// Plan: _plans/2026-06-25-story-editing-canvas-redesign.md.

import { useEffect, useState } from "react";

const STORAGE_KEY = "lorewire.shortPreview.visible";
const CUSTOM_EVENT = "lorewire:short-preview-toggle";

function readVisible(): boolean {
  if (typeof window === "undefined") return true;
  // Default to visible (the editing surface is more useful WITH a
  // preview than without). Only an explicit "0" hides it.
  return window.localStorage.getItem(STORAGE_KEY) !== "0";
}

export function useShortPreviewVisibility(): {
  visible: boolean;
  toggle: () => void;
} {
  // Initial render: SSR returns true (preview visible), client
  // hydrates and reads localStorage in useEffect to avoid a hydration
  // mismatch when the user has chosen to hide it.
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(readVisible());

    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setVisible(e.newValue !== "0");
    }
    function onCustom(e: Event) {
      const ce = e as CustomEvent<boolean>;
      setVisible(ce.detail);
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener(CUSTOM_EVENT, onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CUSTOM_EVENT, onCustom);
    };
  }, []);

  function toggle() {
    const next = !visible;
    setVisible(next);
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    // The native storage event only fires across TABS, not within the
    // same document — dispatch a custom event so the sibling component
    // updates without waiting for a manual reload.
    window.dispatchEvent(new CustomEvent(CUSTOM_EVENT, { detail: next }));
    // eslint-disable-next-line no-console -- rule 14
    console.info("[short preview toggle]", { visible: next });
  }

  return { visible, toggle };
}
