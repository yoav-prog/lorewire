"use client";

// useDebouncedSave — fires a save callback `debounceMs` after the most
// recent call to `request()`. If the user keeps typing/dragging, the
// timer resets. When the timer settles, the callback runs.
//
// Returns the current AutoSaveState so a panel-level <AutoSaveStatus>
// indicator can reflect the lifecycle, plus a `lastError` for the
// caller's tooltip.
//
// Plan: _plans/2026-06-12-admin-ui-overhaul.md (Phase A). This is the
// single piece of auto-save plumbing — every form control in Phases
// B–E calls request() with their new value, and the panel surfaces
// the indicator at the top-right.
//
// Cancels on unmount so a user navigating away mid-edit doesn't fire
// a phantom save against a stale story id.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AutoSaveState } from "./AutoSaveStatus";

export interface UseDebouncedSaveOptions {
  /** Milliseconds to wait after the last `request()` call before
   *  firing the save. Default 500. */
  debounceMs?: number;
  /** How long the "Saved" flash stays before flipping back to idle.
   *  Default 2000ms. */
  savedFlashMs?: number;
}

export interface UseDebouncedSaveReturn<T> {
  request: (value: T) => void;
  state: AutoSaveState;
  lastError: string | null;
  /** Force-flush any pending save immediately. Useful on blur events
   *  for fields that shouldn't wait for the debounce. */
  flush: () => void;
}

export function useDebouncedSave<T>(
  save: (value: T) => Promise<{ ok: boolean; error?: string }>,
  opts: UseDebouncedSaveOptions = {},
): UseDebouncedSaveReturn<T> {
  const { debounceMs = 500, savedFlashMs = 2000 } = opts;
  const [state, setState] = useState<AutoSaveState>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingValueRef = useRef<T | null>(null);
  const cancelledRef = useRef(false);

  const fire = useCallback(async () => {
    const value = pendingValueRef.current;
    if (value === null) return;
    pendingValueRef.current = null;
    setState("saving");
    setLastError(null);
    try {
      const res = await save(value);
      if (cancelledRef.current) return;
      if (res.ok) {
        setState("saved");
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => {
          if (!cancelledRef.current) setState("idle");
        }, savedFlashMs);
      } else {
        setState("error");
        setLastError(res.error ?? "unknown");
      }
    } catch (err) {
      if (cancelledRef.current) return;
      setState("error");
      setLastError(err instanceof Error ? err.message : "unknown");
    }
  }, [save, savedFlashMs]);

  const request = useCallback(
    (value: T) => {
      pendingValueRef.current = value;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(fire, debounceMs);
    },
    [fire, debounceMs],
  );

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingValueRef.current !== null) {
      void fire();
    }
  }, [fire]);

  // Cancel everything on unmount so a phantom save doesn't run against
  // a stale story id when the user navigates away.
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  return { request, state, lastError, flush };
}
