// @vitest-environment happy-dom

// Tests for the wires viewer preference store. Plan additions for slow mode:
// _plans/2026-06-25-slow-mode-playback.md (Layer 1 — persisted pref).
//
// Coverage:
//   - SLOW_MODE_PLAYBACK_RATE matches the locked-in 0.75x decision
//   - the `slow` store defaults to off (opt-in accessibility, not the default)
//   - setSlow / toggleSlow round-trip through localStorage when consent is
//     "accepted" and remain in-memory only when consent is missing
//   - the other prefs (autoplay / muted / advance) keep their existing
//     defaults so the slow-mode addition can't silently regress them

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  SLOW_MODE_PLAYBACK_RATE,
  useWirePrefs,
  type WirePrefs,
} from "@/components/wires/useWirePrefs";

const SLOW_KEY = "lw.wires.slow.v1";
const HIDE_VOTED_KEY = "lw.wires.hide_voted.v1";
const ALL_KEYS = [
  "lw.wires.autoplay.v1",
  "lw.wires.muted.v1",
  "lw.wires.advance.v1",
  SLOW_KEY,
  HIDE_VOTED_KEY,
];

function setConsent(accepted: boolean): void {
  if (accepted) {
    document.cookie = "lw_consent=accepted; path=/";
  } else {
    document.cookie = "lw_consent=; path=/; max-age=0";
  }
}

// Mount a tiny consumer that exposes the hook return value through a ref.
// Lighter than pulling in @testing-library/react and matches the
// createRoot pattern WireCard.test.tsx already uses.
interface MountedHook {
  current: WirePrefs;
  unmount: () => void;
}

function mountHook(): MountedHook {
  let captured: WirePrefs | null = null;

  function Probe(): null {
    captured = useWirePrefs();
    return null;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<Probe />);
  });

  return {
    get current() {
      if (!captured) throw new Error("hook value not captured");
      return captured;
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

beforeEach(() => {
  for (const k of ALL_KEYS) {
    try {
      window.localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
  setConsent(false);
});

afterEach(() => {
  setConsent(false);
});

describe("SLOW_MODE_PLAYBACK_RATE", () => {
  it("is locked at 0.75 (the decision recorded in the plan)", () => {
    // Bumping this changes the user-facing slow-mode speed across both
    // surfaces. Don't bump without revisiting the plan + the audio QA.
    expect(SLOW_MODE_PLAYBACK_RATE).toBe(0.75);
  });
});

describe("useWirePrefs", () => {
  it("defaults to slow=false alongside the existing autoplay/muted/advance defaults", () => {
    const h = mountHook();
    expect(h.current.slow).toBe(false);
    // Sanity-check the other defaults didn't shift while I was here.
    expect(h.current.autoplay).toBe(true);
    expect(h.current.muted).toBe(true);
    expect(h.current.advance).toBe(true);
    // hideVoted defaults ON — the Wires feed opens on unvoted wires.
    expect(h.current.hideVoted).toBe(true);
    h.unmount();
  });

  it("toggleSlow flips the value in-memory even without consent", () => {
    const h = mountHook();
    expect(h.current.slow).toBe(false);
    act(() => {
      h.current.toggleSlow();
    });
    expect(h.current.slow).toBe(true);
    // No consent → nothing written to disk.
    expect(window.localStorage.getItem(SLOW_KEY)).toBeNull();
    h.unmount();
  });

  it("setSlow(true) writes to localStorage when consent is accepted", () => {
    setConsent(true);
    const h = mountHook();
    act(() => {
      h.current.setSlow(true);
    });
    expect(h.current.slow).toBe(true);
    expect(window.localStorage.getItem(SLOW_KEY)).toBe("1");
    h.unmount();
  });

  it("setSlow(false) overwrites a stored '1' with '0' under accepted consent", () => {
    setConsent(true);
    window.localStorage.setItem(SLOW_KEY, "1");
    const h = mountHook();
    // Hook surfaces the persisted value on first subscribe.
    expect(h.current.slow).toBe(true);
    act(() => {
      h.current.setSlow(false);
    });
    expect(h.current.slow).toBe(false);
    expect(window.localStorage.getItem(SLOW_KEY)).toBe("0");
    h.unmount();
  });

  it("toggleSlow round-trips through localStorage across hook instances", () => {
    setConsent(true);
    const first = mountHook();
    act(() => {
      first.current.toggleSlow();
    });
    expect(first.current.slow).toBe(true);
    // A second component mounting sees the persisted value, not the default.
    const second = mountHook();
    expect(second.current.slow).toBe(true);
    first.unmount();
    second.unmount();
  });
});

describe("useWirePrefs — hideVoted (Wires unvoted-only filter)", () => {
  it("toggleHideVoted flips the value in-memory even without consent", () => {
    const h = mountHook();
    expect(h.current.hideVoted).toBe(true);
    act(() => {
      h.current.toggleHideVoted();
    });
    expect(h.current.hideVoted).toBe(false);
    // No consent → nothing written to disk.
    expect(window.localStorage.getItem(HIDE_VOTED_KEY)).toBeNull();
    h.unmount();
  });

  it("setHideVoted(false) writes '0' to localStorage when consent is accepted", () => {
    setConsent(true);
    const h = mountHook();
    act(() => {
      h.current.setHideVoted(false);
    });
    expect(h.current.hideVoted).toBe(false);
    expect(window.localStorage.getItem(HIDE_VOTED_KEY)).toBe("0");
    h.unmount();
  });

  it("toggleHideVoted round-trips through localStorage across hook instances", () => {
    setConsent(true);
    const first = mountHook();
    const before = first.current.hideVoted;
    act(() => {
      first.current.toggleHideVoted();
    });
    expect(first.current.hideVoted).toBe(!before);
    // A second component mounting shares the persisted (module-singleton) value.
    const second = mountHook();
    expect(second.current.hideVoted).toBe(!before);
    first.unmount();
    second.unmount();
  });
});
