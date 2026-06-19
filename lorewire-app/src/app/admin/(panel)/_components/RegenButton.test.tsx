// @vitest-environment happy-dom

// Regression guard for the bug surfaced 2026-06-19 on
// /admin/stories/1oimecw: a successful regen left the button rendering
// a sticky "Queued." chip indefinitely, so the panel read as "queued
// forever" even after the worker had finished cleanly (latest-render
// line below already said "Last regenerated 2m ago · cost $0.05").
//
// The fix dropped the success chip entirely — the panel's per-row
// status line is the source of truth, and a button-local success
// confirmation that never clears is worse than no confirmation. This
// test locks the new behavior: after a successful enqueue, the button
// must surface no "Queued." text. Failure path is still surfaced
// inline because the user needs the budget-exceeded message to know
// why the click did nothing.

import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const enqueueMock = vi.fn();
vi.mock("@/app/admin/actions", () => ({
  enqueueImageRegenAction: (...args: unknown[]) => enqueueMock(...args),
}));

import { RegenButton } from "./RegenButton";

function mount(node: React.ReactElement): {
  container: HTMLDivElement;
  cleanup: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  return {
    container,
    cleanup() {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

async function flushAsync() {
  // Resolve the microtask queue twice: once for the action's await,
  // once for the React 19 transition that schedules the setState.
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("RegenButton", () => {
  it("renders the estimate chip and the action label by default", () => {
    enqueueMock.mockReset();
    const { container, cleanup } = mount(
      <RegenButton
        ownerKind="story"
        ownerId="1oimecw"
        asset="hero_from_short"
        estimateCents={5}
      />,
    );
    expect(container.textContent).toContain("≈ $0.05");
    expect(container.textContent).toContain("Regenerate");
    expect(container.textContent).not.toContain("Queued.");
    cleanup();
  });

  it("does NOT render a sticky 'Queued.' chip after a successful enqueue", async () => {
    enqueueMock.mockReset();
    enqueueMock.mockResolvedValue({
      ok: true,
      id: "fake-id",
    });
    const { container, cleanup } = mount(
      <RegenButton
        ownerKind="story"
        ownerId="1oimecw"
        asset="hero_from_short"
        estimateCents={5}
      />,
    );
    const button = container.querySelector("button");
    if (!button) throw new Error("button not found");
    act(() => {
      button.click();
    });
    await flushAsync();
    expect(enqueueMock).toHaveBeenCalledWith({
      ownerKind: "story",
      ownerId: "1oimecw",
      asset: "hero_from_short",
    });
    // The bug: this used to be "Queued." indefinitely. With the fix,
    // the latest-render line on the panel is the only success surface
    // and the button stays quiet so it can be clicked again without
    // a misleading stale chip.
    expect(container.textContent ?? "").not.toContain("Queued.");
    cleanup();
  });

  it("renders the error explanation when the enqueue is rejected", async () => {
    enqueueMock.mockReset();
    enqueueMock.mockResolvedValue({
      ok: false,
      error: "daily-budget-exceeded",
      capCents: 500,
      spentCents: 480,
    });
    const { container, cleanup } = mount(
      <RegenButton
        ownerKind="story"
        ownerId="1oimecw"
        asset="hero_from_short"
        estimateCents={5}
      />,
    );
    const button = container.querySelector("button");
    if (!button) throw new Error("button not found");
    act(() => {
      button.click();
    });
    await flushAsync();
    const text = container.textContent ?? "";
    expect(text).toContain("Daily budget used");
    expect(text).toContain("$4.80");
    expect(text).toContain("$5.00");
    cleanup();
  });
});
