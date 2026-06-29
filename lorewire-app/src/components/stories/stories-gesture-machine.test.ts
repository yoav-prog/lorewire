// Pure-function coverage for the Stories viewer gesture state machine.
// No DOM, no React — every assertion runs on synthetic event sequences
// fed through reduceGesture(). Lock-in for the user-facing contract:
//
//   - tap left third  → prev (mirrored under RTL)
//   - tap right two-thirds → next (mirrored under RTL)
//   - hold ≥ 150ms     → pause; release → resume
//   - swipe down > 80px OR fling-down → dismiss
//   - swipe up > 80px OR fling-up   → open-reader
//   - small drag that doesn't cross either threshold → snap-back

import { describe, expect, it } from "vitest";

import {
  DEFAULT_GESTURE_CONFIG,
  type GestureConfig,
  type GestureEvent,
  type GestureState,
  INITIAL_GESTURE_STATE,
  reduceGesture,
  resolveTapZone,
} from "./stories-gesture-machine";

const CONFIG: GestureConfig = {
  width: 360,
  height: 800,
  isRtl: false,
  ...DEFAULT_GESTURE_CONFIG,
};

const RTL_CONFIG: GestureConfig = { ...CONFIG, isRtl: true };

/** Run a sequence of events and return the collected actions + final state. */
function runSequence(
  events: GestureEvent[],
  config: GestureConfig = CONFIG,
  start: GestureState = INITIAL_GESTURE_STATE,
) {
  let state = start;
  const actions = [];
  for (const event of events) {
    const result = reduceGesture(state, event, config);
    state = result.state;
    if (result.action) actions.push(result.action);
  }
  return { state, actions };
}

describe("reduceGesture — tap-zone resolution", () => {
  it("LTR: tap in the left third resolves to prev", () => {
    const { actions, state } = runSequence([
      { kind: "pointer-down", x: 20, y: 400, t: 0 },
      { kind: "pointer-up", x: 20, y: 400, t: 100 },
    ]);
    expect(actions).toEqual([{ kind: "tap-prev" }]);
    expect(state.kind).toBe("idle");
  });

  it("LTR: tap in the middle resolves to next (IG semantics)", () => {
    const { actions } = runSequence([
      { kind: "pointer-down", x: 180, y: 400, t: 0 },
      { kind: "pointer-up", x: 180, y: 400, t: 100 },
    ]);
    expect(actions).toEqual([{ kind: "tap-next" }]);
  });

  it("LTR: tap in the right third resolves to next", () => {
    const { actions } = runSequence([
      { kind: "pointer-down", x: 340, y: 400, t: 0 },
      { kind: "pointer-up", x: 340, y: 400, t: 100 },
    ]);
    expect(actions).toEqual([{ kind: "tap-next" }]);
  });

  it("RTL: tap in the left third resolves to next (mirrored)", () => {
    const { actions } = runSequence(
      [
        { kind: "pointer-down", x: 20, y: 400, t: 0 },
        { kind: "pointer-up", x: 20, y: 400, t: 100 },
      ],
      RTL_CONFIG,
    );
    expect(actions).toEqual([{ kind: "tap-next" }]);
  });

  it("RTL: tap in the right third resolves to prev (mirrored)", () => {
    const { actions } = runSequence(
      [
        { kind: "pointer-down", x: 340, y: 400, t: 0 },
        { kind: "pointer-up", x: 340, y: 400, t: 100 },
      ],
      RTL_CONFIG,
    );
    expect(actions).toEqual([{ kind: "tap-prev" }]);
  });

  it("resolveTapZone exposed: width-third boundary lands on the next side", () => {
    // x === width/3 lands in the right zone (the inequality is `<`, not `<=`).
    expect(resolveTapZone(120, { width: 360, isRtl: false })).toEqual({
      kind: "tap-next",
    });
    expect(resolveTapZone(119, { width: 360, isRtl: false })).toEqual({
      kind: "tap-prev",
    });
  });
});

describe("reduceGesture — hold-to-pause", () => {
  it("hold-elapsed in pressing → emits pause + transitions to paused", () => {
    const { actions, state } = runSequence([
      { kind: "pointer-down", x: 180, y: 400, t: 0 },
      { kind: "hold-elapsed", t: 150 },
    ]);
    expect(actions).toEqual([{ kind: "pause" }]);
    expect(state.kind).toBe("paused");
  });

  it("pointer-up after pause → emits resume + returns to idle", () => {
    const { actions, state } = runSequence([
      { kind: "pointer-down", x: 180, y: 400, t: 0 },
      { kind: "hold-elapsed", t: 150 },
      { kind: "pointer-up", x: 180, y: 400, t: 400 },
    ]);
    expect(actions).toEqual([{ kind: "pause" }, { kind: "resume" }]);
    expect(state.kind).toBe("idle");
  });

  it("hold-elapsed while idle is swallowed (no-op)", () => {
    const { actions, state } = runSequence([{ kind: "hold-elapsed", t: 50 }]);
    expect(actions).toEqual([]);
    expect(state.kind).toBe("idle");
  });

  it("hold-elapsed while dragging is swallowed (already past the tap window)", () => {
    const { actions, state } = runSequence([
      { kind: "pointer-down", x: 180, y: 400, t: 0 },
      { kind: "pointer-move", x: 180, y: 430, t: 80 }, // dy 30 > moveStartThreshold
      { kind: "hold-elapsed", t: 200 },
    ]);
    expect(actions).toEqual([]);
    expect(state.kind).toBe("draggingV");
  });

  it("paused → vertical move past threshold promotes to draggingV + emits resume (drag-after-hold)", () => {
    // 2026-06-25 gesture-improvements plan: hold-to-pause used to
    // swallow subsequent moves, forcing the user to release first
    // before swiping. Now a vertical move past moveStartThreshold
    // while paused promotes to draggingV AND emits a synthetic resume
    // so the viewer un-pauses (the user is no longer holding to
    // pause — they're dragging to dismiss / open-reader). Matches IG.
    const { actions, state } = runSequence([
      { kind: "pointer-down", x: 180, y: 400, t: 0 },
      { kind: "hold-elapsed", t: 150 },
      { kind: "pointer-move", x: 180, y: 600, t: 300 },
    ]);
    expect(actions).toEqual([{ kind: "pause" }, { kind: "resume" }]);
    expect(state.kind).toBe("draggingV");
  });

  it("paused → sub-threshold move stays paused (drag-after-hold boundary)", () => {
    // 7px vertical move — below the 8px moveStartThreshold — stays
    // paused. Protects against jittery thumb micro-movements while
    // holding triggering an accidental promote.
    const { actions, state } = runSequence([
      { kind: "pointer-down", x: 180, y: 400, t: 0 },
      { kind: "hold-elapsed", t: 150 },
      { kind: "pointer-move", x: 180, y: 407, t: 300 },
    ]);
    expect(actions).toEqual([{ kind: "pause" }]);
    expect(state.kind).toBe("paused");
  });

  it("paused → drag past threshold → pointer-up past dismissThreshold → dismiss", () => {
    // Full drag-after-hold flow: hold to pause, drag down past the
    // moveStartThreshold (promotes + resume), continue dragging past
    // dismissThreshold, release → emits dismiss. Symmetric with the
    // existing draggingV-from-pressing flow.
    const { actions, state } = runSequence([
      { kind: "pointer-down", x: 180, y: 400, t: 0 },
      { kind: "hold-elapsed", t: 150 },
      { kind: "pointer-move", x: 180, y: 450, t: 300 }, // dy 50 ≥ 8 → promotes
      { kind: "pointer-up", x: 180, y: 500, t: 500 }, // dy 100 > 80 → dismiss
    ]);
    expect(actions).toEqual([
      { kind: "pause" },
      { kind: "resume" },
      { kind: "dismiss" },
    ]);
    expect(state.kind).toBe("idle");
  });
});

describe("reduceGesture — vertical drag (dismiss / open-reader / snap-back)", () => {
  it("swipe down past dismissThreshold → emits dismiss", () => {
    const { actions, state } = runSequence([
      { kind: "pointer-down", x: 180, y: 400, t: 0 },
      { kind: "pointer-move", x: 180, y: 440, t: 50 },
      { kind: "pointer-up", x: 180, y: 500, t: 200 }, // dy 100 > 80
    ]);
    expect(actions).toEqual([{ kind: "dismiss" }]);
    expect(state.kind).toBe("idle");
  });

  it("swipe up past dismissThreshold → emits open-reader", () => {
    const { actions } = runSequence([
      { kind: "pointer-down", x: 180, y: 400, t: 0 },
      { kind: "pointer-move", x: 180, y: 350, t: 50 },
      { kind: "pointer-up", x: 180, y: 280, t: 200 }, // dy -120
    ]);
    expect(actions).toEqual([{ kind: "open-reader" }]);
  });

  it("fling-down: short distance but high velocity still dismisses", () => {
    // dy = 50 (below 80 threshold), dt = 60ms → velocity ≈ 0.83 > 0.6
    const { actions } = runSequence([
      { kind: "pointer-down", x: 180, y: 400, t: 0 },
      { kind: "pointer-move", x: 180, y: 430, t: 20 },
      { kind: "pointer-up", x: 180, y: 450, t: 60 },
    ]);
    expect(actions).toEqual([{ kind: "dismiss" }]);
  });

  it("fling-up: short distance but high velocity → open-reader", () => {
    // dy = -50, dt = 60ms → velocity ≈ -0.83
    const { actions } = runSequence([
      { kind: "pointer-down", x: 180, y: 400, t: 0 },
      { kind: "pointer-move", x: 180, y: 380, t: 20 },
      { kind: "pointer-up", x: 180, y: 350, t: 60 },
    ]);
    expect(actions).toEqual([{ kind: "open-reader" }]);
  });

  it("slow short drag (under both distance + velocity thresholds) → snap-back", () => {
    // dy = 30, dt = 200ms → velocity 0.15
    const { actions, state } = runSequence([
      { kind: "pointer-down", x: 180, y: 400, t: 0 },
      { kind: "pointer-move", x: 180, y: 420, t: 100 },
      { kind: "pointer-up", x: 180, y: 430, t: 200 },
    ]);
    expect(actions).toEqual([{ kind: "snap-back" }]);
    expect(state.kind).toBe("idle");
  });

  it("moveStartThreshold: 7px vertical move stays in pressing (tap still possible)", () => {
    const { actions, state } = runSequence([
      { kind: "pointer-down", x: 180, y: 400, t: 0 },
      { kind: "pointer-move", x: 180, y: 407, t: 50 },
      { kind: "pointer-up", x: 180, y: 407, t: 100 },
    ]);
    expect(actions).toEqual([{ kind: "tap-next" }]);
    expect(state.kind).toBe("idle");
  });

  it("moveStartThreshold: 8px vertical move escalates to draggingV", () => {
    const { state } = runSequence([
      { kind: "pointer-down", x: 180, y: 400, t: 0 },
      { kind: "pointer-move", x: 180, y: 408, t: 50 },
    ]);
    expect(state.kind).toBe("draggingV");
  });
});

describe("reduceGesture — edge cases", () => {
  it("pointer-down while already pressing restarts the gesture", () => {
    const { state } = runSequence([
      { kind: "pointer-down", x: 100, y: 100, t: 0 },
      { kind: "pointer-down", x: 200, y: 200, t: 10 },
    ]);
    expect(state).toEqual({
      kind: "pressing",
      startX: 200,
      startY: 200,
      startT: 10,
      currentY: 200,
      currentT: 10,
    });
  });

  it("pointer-up while idle is a no-op (defensive: lost-pointer recovery)", () => {
    const { actions, state } = runSequence([
      { kind: "pointer-up", x: 100, y: 100, t: 0 },
    ]);
    expect(actions).toEqual([]);
    expect(state.kind).toBe("idle");
  });

  it("pointer-move while idle is a no-op", () => {
    const { actions, state } = runSequence([
      { kind: "pointer-move", x: 100, y: 100, t: 0 },
    ]);
    expect(actions).toEqual([]);
    expect(state.kind).toBe("idle");
  });
});

describe("reduceGesture — full sequences (realistic scenarios)", () => {
  it("tap-prev then tap-next then dismiss", () => {
    const { actions } = runSequence([
      // tap-prev
      { kind: "pointer-down", x: 20, y: 400, t: 0 },
      { kind: "pointer-up", x: 20, y: 400, t: 80 },
      // tap-next
      { kind: "pointer-down", x: 300, y: 400, t: 500 },
      { kind: "pointer-up", x: 300, y: 400, t: 580 },
      // dismiss via swipe-down
      { kind: "pointer-down", x: 180, y: 400, t: 1000 },
      { kind: "pointer-move", x: 180, y: 450, t: 1050 },
      { kind: "pointer-up", x: 180, y: 520, t: 1200 },
    ]);
    expect(actions).toEqual([
      { kind: "tap-prev" },
      { kind: "tap-next" },
      { kind: "dismiss" },
    ]);
  });

  it("hold-pause then resume then tap-next", () => {
    const { actions } = runSequence([
      { kind: "pointer-down", x: 180, y: 400, t: 0 },
      { kind: "hold-elapsed", t: 150 },
      { kind: "pointer-up", x: 180, y: 400, t: 800 },
      { kind: "pointer-down", x: 300, y: 400, t: 900 },
      { kind: "pointer-up", x: 300, y: 400, t: 950 },
    ]);
    expect(actions).toEqual([
      { kind: "pause" },
      { kind: "resume" },
      { kind: "tap-next" },
    ]);
  });
});
