// @vitest-environment happy-dom

// Tests for the debounced auto-save hook. Uses Vitest fake timers
// to control the debounce window deterministically. React 19's
// concurrent rendering makes synchronous `act()` work for state
// transitions, but we still wait for microtasks between timer ticks.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDebouncedSave } from "./useDebouncedSave";

// React's renderHook ships in 19.2; if your environment ships an
// older copy that lacks it, fall back to a manual hook host.
function host<T>(hook: () => T): { current: T; cleanup: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  const result = { current: undefined as unknown as T };
  function Probe() {
    result.current = hook();
    return null;
  }
  act(() => {
    root = createRoot(container);
    root.render(<Probe />);
  });
  return {
    get current() {
      return result.current;
    },
    cleanup() {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

describe("useDebouncedSave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces save calls by debounceMs", async () => {
    const save = vi.fn(async () => ({ ok: true }));
    const h = host(() => useDebouncedSave(save, { debounceMs: 500 }));

    act(() => h.current.request("a"));
    act(() => h.current.request("b"));
    act(() => h.current.request("c"));

    // No save fired yet — still inside the window.
    expect(save).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("c");

    h.cleanup();
  });

  it("transitions idle → saving → saved → idle", async () => {
    let resolveSave: (v: { ok: boolean }) => void = () => undefined;
    const save = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((res) => {
          resolveSave = res;
        }),
    );
    const h = host(() =>
      useDebouncedSave(save, { debounceMs: 100, savedFlashMs: 200 }),
    );

    expect(h.current.state).toBe("idle");

    act(() => h.current.request("x"));
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(h.current.state).toBe("saving");

    await act(async () => {
      resolveSave({ ok: true });
    });
    expect(h.current.state).toBe("saved");

    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(h.current.state).toBe("idle");

    h.cleanup();
  });

  it("flips to error on a rejected save and surfaces the error", async () => {
    const save = vi.fn(async () => ({ ok: false, error: "session-stolen" }));
    const h = host(() => useDebouncedSave(save, { debounceMs: 100 }));

    act(() => h.current.request("x"));
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    // Microtask drain for the promise resolution.
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.current.state).toBe("error");
    expect(h.current.lastError).toBe("session-stolen");

    h.cleanup();
  });

  it("flush() runs the pending save immediately, bypassing the debounce", async () => {
    const save = vi.fn(async () => ({ ok: true }));
    const h = host(() => useDebouncedSave(save, { debounceMs: 500 }));

    act(() => h.current.request("y"));
    expect(save).not.toHaveBeenCalled();

    await act(async () => {
      h.current.flush();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("y");

    h.cleanup();
  });

  it("does not call save after unmount, even if a timer was queued", () => {
    const save = vi.fn(async () => ({ ok: true }));
    const h = host(() => useDebouncedSave(save, { debounceMs: 500 }));
    act(() => h.current.request("z"));
    h.cleanup();
    vi.advanceTimersByTime(500);
    expect(save).not.toHaveBeenCalled();
  });
});
