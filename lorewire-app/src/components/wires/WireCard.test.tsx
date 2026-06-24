// @vitest-environment happy-dom

// Coverage for the WireCard player's play/pause race handling. The real-world
// symptom this guards against (manager-reported 2026-06-24): swiping between
// shorts occasionally strands a card with the centre Play overlay even though
// autoplay is on. Cause: a pause() during a pending play() rejects the play
// Promise with AbortError, which the old code treated as a real autoplay
// block. The fix in WireCard.tsx ignores AbortError, surfaces a real
// NotAllowedError, and uses a generation counter so stale rejections from
// swiped-past cards can't clobber the active card's state.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import WireCard, { type WireCardProps } from "./WireCard";
import type { WireStory } from "@/app/actions";

interface PendingPlay {
  resolve: () => void;
  reject: (e: Error) => void;
}

let playCalls = 0;
let pauseCalls = 0;
let pendingPlays: PendingPlay[] = [];
let originalPlay: PropertyDescriptor | undefined;
let originalPause: PropertyDescriptor | undefined;

beforeEach(() => {
  playCalls = 0;
  pauseCalls = 0;
  pendingPlays = [];
  originalPlay = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "play",
  );
  originalPause = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "pause",
  );
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    writable: true,
    value: function play(this: HTMLMediaElement): Promise<void> {
      playCalls++;
      return new Promise<void>((resolve, reject) => {
        pendingPlays.push({ resolve, reject });
      });
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    writable: true,
    value: function pause(this: HTMLMediaElement) {
      pauseCalls++;
    },
  });
  // Silence the expected "[wires play interrupted]" / "[wires play blocked]"
  // logs so the test runner output stays clean.
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  if (originalPlay) {
    Object.defineProperty(HTMLMediaElement.prototype, "play", originalPlay);
  }
  if (originalPause) {
    Object.defineProperty(HTMLMediaElement.prototype, "pause", originalPause);
  }
  vi.restoreAllMocks();
});

function makeStory(): WireStory {
  return {
    id: "wire-1",
    slug: "wire-1",
    title: "Test wire",
    category: "Drama",
    summary: null,
    duration: "0:30",
    hero_image: null,
    hero_image_landscape: null,
    hero_has_baked_title: 0,
    video_url: "https://example.invalid/v.mp4",
    published_at: null,
    created_at: null,
    like_count: 0,
    viewer_liked: false,
  };
}

function defaultProps(overrides: Partial<WireCardProps> = {}): WireCardProps {
  return {
    short: makeStory(),
    active: true,
    mounted: true,
    muted: true,
    autoplay: true,
    advance: true,
    reducedMotion: false,
    paused: false,
    eager: true,
    insetBottom: 16,
    onToggleMute: () => undefined,
    onToggleAutoplay: () => undefined,
    onToggleAdvance: () => undefined,
    onOpenInfo: () => undefined,
    showSoundHint: false,
    onDismissSoundHint: () => undefined,
    liked: false,
    likeCount: 0,
    saved: false,
    onToggleLike: () => undefined,
    onToggleSave: () => undefined,
    ...overrides,
  };
}

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

function mount(props: WireCardProps): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<WireCard {...props} />);
  });
  return { container, root };
}

function rerender(m: Mounted, props: WireCardProps): void {
  act(() => {
    m.root.render(<WireCard {...props} />);
  });
}

function unmount(m: Mounted): void {
  act(() => {
    m.root.unmount();
  });
  m.container.remove();
}

function findPlayOverlay(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-label="Play"]');
}

describe("WireCard play/pause race", () => {
  it("does NOT strand a tap-to-play overlay after a pause-during-play AbortError", async () => {
    const m = mount(defaultProps({ active: true }));

    // Initial render fires tryPlay once via the shouldPlay effect.
    expect(playCalls).toBe(1);
    expect(pendingPlays).toHaveLength(1);
    const firstPlay = pendingPlays[0];

    // User swipes away: card becomes inactive. The shouldPlay effect bumps
    // the generation counter and calls v.pause(). The browser will reject
    // the pending play() with AbortError on the next microtask.
    rerender(m, defaultProps({ active: false }));
    expect(pauseCalls).toBeGreaterThanOrEqual(1);

    await act(async () => {
      firstPlay.reject(
        Object.assign(new Error("interrupted"), { name: "AbortError" }),
      );
      // Drain the catch microtask.
      await Promise.resolve();
      await Promise.resolve();
    });

    // User swipes back. shouldPlay flips true → tryPlay fires a fresh play().
    rerender(m, defaultProps({ active: true }));
    expect(playCalls).toBe(2);
    expect(pendingPlays).toHaveLength(2);

    // The new play resolves cleanly.
    await act(async () => {
      pendingPlays[1].resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Critical assertion: the centre Play overlay must NOT be visible. The
    // AbortError from the swipe-past race must not have stranded blocked=true.
    expect(findPlayOverlay(m.container)).toBeNull();

    unmount(m);
  });

  it("DOES surface the tap-to-play overlay on a real NotAllowedError", async () => {
    const m = mount(defaultProps({ active: true }));
    expect(pendingPlays).toHaveLength(1);

    await act(async () => {
      pendingPlays[0].reject(
        Object.assign(new Error("blocked by policy"), {
          name: "NotAllowedError",
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findPlayOverlay(m.container)).not.toBeNull();

    unmount(m);
  });

  it("does not show the overlay on the happy path (play resolves)", async () => {
    const m = mount(defaultProps({ active: true }));
    expect(pendingPlays).toHaveLength(1);

    await act(async () => {
      pendingPlays[0].resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findPlayOverlay(m.container)).toBeNull();

    unmount(m);
  });

  it("ignores a stale AbortError from a tryPlay the user has already swiped past", async () => {
    // This is the microtask-ordering hazard: the stale rejection fires AFTER
    // the user has come back to the card and a fresh tryPlay has resolved.
    // Without the generation guard, setBlocked(true) would overwrite the
    // fresh setBlocked(false) and the overlay would stick.
    const m = mount(defaultProps({ active: true }));
    expect(pendingPlays).toHaveLength(1);
    const stalePlay = pendingPlays[0];

    rerender(m, defaultProps({ active: false }));
    rerender(m, defaultProps({ active: true }));
    expect(playCalls).toBe(2);
    const freshPlay = pendingPlays[1];

    await act(async () => {
      // Fresh play resolves FIRST.
      freshPlay.resolve();
      await Promise.resolve();
      // Then the stale rejection arrives (interleaved microtasks IRL).
      stalePlay.reject(
        Object.assign(new Error("interrupted"), { name: "AbortError" }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findPlayOverlay(m.container)).toBeNull();

    unmount(m);
  });
});
