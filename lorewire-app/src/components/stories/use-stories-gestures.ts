"use client";

// React glue between the pure gesture reducer (stories-gesture-machine.ts)
// and the browser's Pointer Events. The hook owns:
//
//   - attaching pointerdown/move/up/cancel on a target element
//   - starting + clearing the hold timer
//   - measuring the element so the reducer can resolve tap-zones
//   - calling out to the viewer's onAction callback
//
// We deliberately do NOT call setState here — the reducer's state is held
// in a ref so a fast pointer-move stream doesn't trigger React renders.
// The only React state the viewer needs is the active wire index, mute,
// paused, etc. — all already owned by the viewer.

import { useCallback, useEffect, useRef } from "react";

import {
  DEFAULT_GESTURE_CONFIG,
  type GestureAction,
  type GestureConfig,
  type GestureState,
  INITIAL_GESTURE_STATE,
  reduceGesture,
} from "./stories-gesture-machine";

export interface UseStoriesGesturesOptions {
  /** Fires each time the reducer resolves an event into an intent. */
  onAction: (action: GestureAction) => void;
  /** When true, mirror tap-zones for RTL documents. Defaults to reading
   *  `document.dir === "rtl"` on first mount. */
  isRtl?: boolean;
  /** Override the hold timer threshold (ms). */
  holdMs?: number;
  /** Optional override for the dismiss distance / velocity thresholds.
   *  Useful for component tests; production callers should leave the
   *  defaults alone. */
  thresholds?: Partial<typeof DEFAULT_GESTURE_CONFIG>;
}

export interface UseStoriesGesturesResult {
  /** Attach to the target element via React's ref prop. */
  ref: React.RefObject<HTMLDivElement | null>;
}

export function useStoriesGestures(
  options: UseStoriesGesturesOptions,
): UseStoriesGesturesResult {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<GestureState>(INITIAL_GESTURE_STATE);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest options snapshot so the pointer handlers (which we install
  // once per element mount) always call the freshest onAction. Without
  // this, the handler would close over a stale callback when the viewer
  // re-renders.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const dispatchEvent = useCallback(
    (kind: "pointer-down" | "pointer-move" | "pointer-up" | "hold-elapsed", e?: PointerEvent) => {
      const el = elementRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const config: GestureConfig = {
        width: rect.width,
        height: rect.height,
        isRtl:
          optionsRef.current.isRtl ??
          (typeof document !== "undefined" && document.dir === "rtl"),
        holdThresholdMs:
          optionsRef.current.holdMs ?? DEFAULT_GESTURE_CONFIG.holdThresholdMs,
        moveStartThreshold:
          optionsRef.current.thresholds?.moveStartThreshold ??
          DEFAULT_GESTURE_CONFIG.moveStartThreshold,
        dismissThreshold:
          optionsRef.current.thresholds?.dismissThreshold ??
          DEFAULT_GESTURE_CONFIG.dismissThreshold,
        dismissVelocityThreshold:
          optionsRef.current.thresholds?.dismissVelocityThreshold ??
          DEFAULT_GESTURE_CONFIG.dismissVelocityThreshold,
      };
      const now = performance.now();
      let event;
      if (kind === "hold-elapsed") {
        event = { kind, t: now } as const;
      } else if (e) {
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        event = { kind, x, y, t: now } as const;
      } else {
        return;
      }
      const result = reduceGesture(stateRef.current, event, config);
      stateRef.current = result.state;
      if (result.action) {
        // eslint-disable-next-line no-console -- rule 14
        console.info("[stories gesture]", {
          kind: result.action.kind,
          state: result.state.kind,
        });
        optionsRef.current.onAction(result.action);
      }
    },
    [],
  );

  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    const onPointerDown = (e: PointerEvent) => {
      // Accept mouse, touch, and pen — pen events flow through the
      // same PointerEvent shape and the gesture machine doesn't care
      // about pointer type. Surface / iPad-with-pen users can drive
      // the viewer the same way a finger does.
      if (
        e.pointerType !== "mouse" &&
        e.pointerType !== "touch" &&
        e.pointerType !== "pen"
      ) {
        return;
      }
      // Capture so we still get pointer-up if the user lifts off the
      // element. Without this, fast vertical drags leave the machine
      // stuck in draggingV.
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* setPointerCapture can throw on stale pointer ids — ignore */
      }
      dispatchEvent("pointer-down", e);
      clearHoldTimer();
      holdTimerRef.current = setTimeout(() => {
        dispatchEvent("hold-elapsed");
      }, optionsRef.current.holdMs ?? DEFAULT_GESTURE_CONFIG.holdThresholdMs);
    };
    const onPointerMove = (e: PointerEvent) => {
      // Only react when at least one button is held OR a pointer was
      // previously captured. PointerEvent.buttons is 0 for hover.
      if (e.buttons === 0 && !el.hasPointerCapture(e.pointerId)) return;
      dispatchEvent("pointer-move", e);
    };
    const onPointerUp = (e: PointerEvent) => {
      clearHoldTimer();
      dispatchEvent("pointer-up", e);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* same defensive notes as setPointerCapture */
      }
    };
    const onPointerCancel = (e: PointerEvent) => {
      // Treat cancel (e.g., the OS yanked the pointer for a context
      // menu) as a pointer-up at the current position so the machine
      // resolves to snap-back instead of staying stuck.
      clearHoldTimer();
      dispatchEvent("pointer-up", e);
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerCancel);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerCancel);
      clearHoldTimer();
    };
  }, [dispatchEvent, clearHoldTimer]);

  return { ref: elementRef };
}
