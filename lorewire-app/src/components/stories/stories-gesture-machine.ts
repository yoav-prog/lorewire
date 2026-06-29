// Gesture state machine for the IG-style Stories viewer.
//
// The viewer's interaction model has four kinds of input — tap, hold,
// vertical drag, and the auto-advance timer — and each one resolves
// into one of a small set of intents: prev / next / pause / resume /
// dismiss / open-reader / nothing. Bundling all of that into a React
// component leaks pointer timing into the render tree and makes it
// impossible to test the contract without a DOM. So we keep the state
// machine here as a pure reducer over a small event/state alphabet and
// let the React hook (use-stories-gestures.ts) glue it to PointerEvents
// + the hold timer.
//
// States:
//   - "idle"         — no pointer pressed; auto-advance timer drives the bar.
//   - "pressing"     — pointer is down; we're still deciding whether this
//                      becomes a tap, a hold (pause), or a vertical drag.
//   - "paused"       — hold detected. We pause the timer; on pointer-up we
//                      resume. If the user then drags vertically past
//                      moveStartThreshold without releasing, we promote
//                      to draggingV + emit a synthetic resume (drag-
//                      after-hold).
//   - "draggingV"    — vertical move crossed the move-start threshold; we
//                      track currentY so the viewer can apply a parallax
//                      and we resolve to dismiss / open-reader / snap-back
//                      on pointer-up.
//
// Tap zones (LTR, mirrored under RTL by swapping prev/next):
//   - Left third of the frame  → prev
//   - Right two-thirds         → next   (matches IG; middle is "next")
//
// Plans:
//   - _plans/2026-06-25-stories-rail-and-viewer.md (v1)
//   - _plans/2026-06-25-stories-gesture-improvements.md (drag-after-hold)

/** All inputs the machine can consume. `t` is a monotonically increasing
 *  millisecond timestamp (performance.now() in the React glue, anything
 *  monotonic in tests). */
export type GestureEvent =
  | { kind: "pointer-down"; x: number; y: number; t: number }
  | { kind: "pointer-move"; x: number; y: number; t: number }
  | { kind: "pointer-up"; x: number; y: number; t: number }
  | { kind: "hold-elapsed"; t: number };

/** Intents the viewer must act on. Returned from each reduce(). Multiple
 *  events can fire in one frame, so the reducer always returns at most
 *  one action — the viewer dispatches it before processing the next
 *  event. */
export type GestureAction =
  | { kind: "tap-prev" }
  | { kind: "tap-next" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "dismiss" }
  | { kind: "open-reader" }
  | { kind: "snap-back" };

/** Configuration: rectangle, RTL flag, and behavior thresholds. */
export interface GestureConfig {
  /** Frame width in CSS pixels — used to compute the tap zones. */
  width: number;
  /** Frame height in CSS pixels — informational; not currently load-bearing. */
  height: number;
  /** True when the surrounding document is RTL (Hebrew, Arabic). Mirrors
   *  the tap-zone mapping. The React glue reads `document.dir`. */
  isRtl: boolean;
  /** Milliseconds the pointer must stay down (with low movement) before
   *  the machine emits a `pause`. Default 150ms. */
  holdThresholdMs: number;
  /** Pixel distance the pointer can move and still register as a tap.
   *  Beyond this we transition to draggingV. */
  moveStartThreshold: number;
  /** Vertical pixels the pointer must travel for an up-pointer to count
   *  as a dismiss / open-reader rather than a snap-back. */
  dismissThreshold: number;
  /** Vertical velocity (px/ms) at pointer-up that also counts as a
   *  dismiss / open-reader, even if total distance < dismissThreshold.
   *  Catches the "fling" gesture. */
  dismissVelocityThreshold: number;
}

export const DEFAULT_GESTURE_CONFIG: Omit<GestureConfig, "width" | "height" | "isRtl"> = {
  holdThresholdMs: 150,
  moveStartThreshold: 8,
  dismissThreshold: 80,
  dismissVelocityThreshold: 0.6,
};

/** Internal state. Exposed for tests; the React glue treats it as opaque. */
export type GestureState =
  | { kind: "idle" }
  | {
      kind: "pressing";
      startX: number;
      startY: number;
      startT: number;
      currentY: number;
      currentT: number;
    }
  | {
      kind: "paused";
      startX: number;
      startY: number;
      startT: number;
    }
  | {
      kind: "draggingV";
      startX: number;
      startY: number;
      startT: number;
      currentY: number;
      currentT: number;
    };

export const INITIAL_GESTURE_STATE: GestureState = { kind: "idle" };

/** Pure reducer. Consumes one event, returns the next state and at most
 *  one action. */
export function reduceGesture(
  state: GestureState,
  event: GestureEvent,
  config: GestureConfig,
): { state: GestureState; action: GestureAction | null } {
  switch (event.kind) {
    case "pointer-down": {
      // Any pointer-down resets to a fresh pressing state. Mid-gesture
      // re-down (e.g., a second finger) is treated as a brand-new
      // gesture — the viewer should layer-block multi-touch upstream
      // if it cares about precise multi-pointer behavior.
      return {
        state: {
          kind: "pressing",
          startX: event.x,
          startY: event.y,
          startT: event.t,
          currentY: event.y,
          currentT: event.t,
        },
        action: null,
      };
    }

    case "hold-elapsed": {
      // Hold timer can only escalate from `pressing`. If we're already
      // paused, dragging, or idle, swallow it. Carry startX/Y/T into
      // the paused state so a subsequent pointer-move can promote to
      // draggingV (drag-after-hold) without losing the gesture origin.
      if (state.kind !== "pressing") {
        return { state, action: null };
      }
      return {
        state: {
          kind: "paused",
          startX: state.startX,
          startY: state.startY,
          startT: state.startT,
        },
        action: { kind: "pause" },
      };
    }

    case "pointer-move": {
      if (state.kind === "idle") return { state, action: null };
      if (state.kind === "paused") {
        // Drag-after-hold: a vertical move past the threshold while
        // paused promotes to draggingV AND emits a synthetic resume
        // so the viewer un-pauses (the user is no longer holding to
        // pause, they're now dragging to dismiss / open-reader).
        // Matches IG's behavior. Sub-threshold moves stay paused.
        const dy = event.y - state.startY;
        if (Math.abs(dy) >= config.moveStartThreshold) {
          return {
            state: {
              kind: "draggingV",
              startX: state.startX,
              startY: state.startY,
              startT: state.startT,
              currentY: event.y,
              currentT: event.t,
            },
            action: { kind: "resume" },
          };
        }
        return { state, action: null };
      }
      if (state.kind === "pressing") {
        const dy = event.y - state.startY;
        if (Math.abs(dy) >= config.moveStartThreshold) {
          return {
            state: {
              kind: "draggingV",
              startX: state.startX,
              startY: state.startY,
              startT: state.startT,
              currentY: event.y,
              currentT: event.t,
            },
            action: null,
          };
        }
        return {
          state: { ...state, currentY: event.y, currentT: event.t },
          action: null,
        };
      }
      // draggingV: just track the new position.
      return {
        state: { ...state, currentY: event.y, currentT: event.t },
        action: null,
      };
    }

    case "pointer-up": {
      if (state.kind === "idle") return { state, action: null };
      if (state.kind === "paused") {
        // Always resume on release. The hold-to-pause UX promise is
        // "pause while held"; "tap-to-pause" would conflict with the
        // tap-zones for prev/next.
        return { state: { kind: "idle" }, action: { kind: "resume" } };
      }
      if (state.kind === "pressing") {
        // Tap. The pointer was held below moveStartThreshold for less
        // than holdThresholdMs (otherwise we'd be in paused or
        // draggingV). Resolve to a tap-zone action.
        return { state: { kind: "idle" }, action: resolveTapZone(event.x, config) };
      }
      // draggingV: resolve to dismiss / open-reader / snap-back based on
      // total distance + instantaneous velocity at pointer-up.
      const dy = event.y - state.startY;
      const dt = Math.max(1, event.t - state.startT);
      const v = dy / dt; // px/ms — positive = downward
      const fling = Math.abs(v) >= config.dismissVelocityThreshold;
      if (dy >= config.dismissThreshold || (fling && v > 0)) {
        return { state: { kind: "idle" }, action: { kind: "dismiss" } };
      }
      if (dy <= -config.dismissThreshold || (fling && v < 0)) {
        return { state: { kind: "idle" }, action: { kind: "open-reader" } };
      }
      return { state: { kind: "idle" }, action: { kind: "snap-back" } };
    }
  }
}

/** Resolve the x-coordinate of a tap into prev/next under LTR or RTL.
 *  Exposed for tests so the boundary cases are easy to lock in. */
export function resolveTapZone(
  x: number,
  config: Pick<GestureConfig, "width" | "isRtl">,
): GestureAction {
  const leftThird = config.width / 3;
  // LTR: left third → prev, right two-thirds → next.
  // RTL: mirror — left third → next, right two-thirds → prev.
  const leftAction: GestureAction = config.isRtl ? { kind: "tap-next" } : { kind: "tap-prev" };
  const rightAction: GestureAction = config.isRtl ? { kind: "tap-prev" } : { kind: "tap-next" };
  return x < leftThird ? leftAction : rightAction;
}
