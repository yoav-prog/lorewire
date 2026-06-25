// @vitest-environment happy-dom

// State-machine coverage for the per-wire poll panel
// (_plans/2026-06-25-wires-poll-wrapper.md):
//   - pre-vote (no votes / below floor / above floor)
//   - optimistic vote → server-patched result
//   - vote fetch error → revert to pre-vote + surface an error
//   - vote network error → revert to pre-vote + surface an error
//   - server-resolved initial vote → first paint is the post-vote bars
//
// We DON'T cover the Top-10 ranking emit (`recordStoryEventAction`) here —
// it's a fire-and-forget dynamic import that's already covered by
// PollWidget's tests; the panel just mirrors that path so duplicating
// the coverage adds nothing.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WirePollPanel } from "./WirePollPanel";
import type {
  PollResultView,
  WirePollData,
} from "@/lib/polls-shared";

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

function mount(node: React.ReactNode): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  return { container, root };
}

function unmount(m: Mounted): void {
  act(() => {
    m.root.unmount();
  });
  m.container.remove();
}

function makePoll(overrides: Partial<WirePollData> = {}): WirePollData {
  return {
    pollId: "poll-1",
    question: "Was that smart pushback, or too far?",
    optionA: "Smart Pushback",
    optionB: "Too Far",
    initialResult: null,
    initialVotedSide: null,
    ...overrides,
  };
}

function findChoiceButton(
  container: HTMLElement,
  side: "A" | "B",
): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `button[data-side="${side}"]`,
  );
}

function findResultRow(
  container: HTMLElement,
  side: "A" | "B",
): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    `div[data-side="${side}"][data-highlighted]`,
  );
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  // happy-dom keeps the global fetch from the previous test alive
  // between cases; tear it down so a leftover mock can't pollute the
  // next assertion.
  if ("fetch" in globalThis) {
    Reflect.deleteProperty(globalThis, "fetch");
  }
});

describe("WirePollPanel — pre-vote", () => {
  it("renders both choice buttons and the 'be one of the first' kicker when there are no votes yet", () => {
    const m = mount(<WirePollPanel storyId="s1" poll={makePoll()} />);
    expect(findChoiceButton(m.container, "A")).not.toBeNull();
    expect(findChoiceButton(m.container, "B")).not.toBeNull();
    // No result rows should render in the pre-vote state.
    expect(findResultRow(m.container, "A")).toBeNull();
    expect(findResultRow(m.container, "B")).toBeNull();
    expect(m.container.textContent).toContain("Be one of the first");
    unmount(m);
  });

  it("shows the 'tap to reveal the split' kicker once the floor is reached", () => {
    const result: PollResultView = {
      totalVotes: 250,
      hasFloor: true,
      pctA: 60,
      pctB: 40,
      divisiveness: 0.8,
      lastVoteAt: null,
    };
    const m = mount(
      <WirePollPanel
        storyId="s1"
        poll={makePoll({ initialResult: result })}
      />,
    );
    expect(m.container.textContent).toContain("Tap a side to reveal the split");
    // Vote count surfaces only once the floor is met.
    expect(m.container.textContent).toContain("250 votes");
    unmount(m);
  });
});

describe("WirePollPanel — vote flow", () => {
  it("optimistically paints results immediately, then patches percentages from the server", async () => {
    const fetched: PollResultView = {
      totalVotes: 1234,
      hasFloor: true,
      pctA: 72,
      pctB: 28,
      divisiveness: 0.56,
      lastVoteAt: null,
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        inserted: true,
        result: fetched,
      }),
    }));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock as unknown as typeof fetch,
    });

    const onVoted = vi.fn();
    const m = mount(
      <WirePollPanel storyId="s1" poll={makePoll()} onVoted={onVoted} />,
    );
    const btnA = findChoiceButton(m.container, "A");
    expect(btnA).not.toBeNull();

    await act(async () => {
      btnA!.click();
    });

    // Right after click the panel should already be in post-vote layout
    // (optimistic paint) — the user's side bar is rendered before the
    // fetch resolves.
    expect(findResultRow(m.container, "A")).not.toBeNull();
    expect(findChoiceButton(m.container, "A")).toBeNull();

    // Drain the fetch microtasks.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Server result patched in: percentages and verdict reflect 72/28.
    expect(m.container.textContent).toContain("72%");
    expect(m.container.textContent).toContain("28%");
    expect(m.container.textContent).toContain("1,234 votes");
    expect(m.container.textContent).toContain("You're with the majority");

    // Parent was notified so it can flip the floating pill.
    expect(onVoted).toHaveBeenCalledTimes(1);
    expect(onVoted).toHaveBeenCalledWith("A", fetched);

    unmount(m);
  });

  it("reverts to the pre-vote state and surfaces an error when the vote endpoint returns a non-ok body", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ ok: false, error: "rate limited" }),
    }));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock as unknown as typeof fetch,
    });

    const m = mount(<WirePollPanel storyId="s1" poll={makePoll()} />);
    const btnB = findChoiceButton(m.container, "B");
    expect(btnB).not.toBeNull();

    await act(async () => {
      btnB!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Choice buttons are back on screen; the result row from the
    // optimistic paint is gone.
    expect(findChoiceButton(m.container, "A")).not.toBeNull();
    expect(findChoiceButton(m.container, "B")).not.toBeNull();
    expect(findResultRow(m.container, "B")).toBeNull();

    // Inline error banner is visible to the user.
    const alert = m.container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Couldn't record your vote");

    unmount(m);
  });

  it("reverts and surfaces a network-error message when the fetch throws", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock as unknown as typeof fetch,
    });

    const m = mount(<WirePollPanel storyId="s1" poll={makePoll()} />);
    const btnA = findChoiceButton(m.container, "A");

    await act(async () => {
      btnA!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findChoiceButton(m.container, "A")).not.toBeNull();
    const alert = m.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't reach the server");

    unmount(m);
  });
});

describe("WirePollPanel — server-resolved initial state", () => {
  it("renders the post-vote bars on first paint when the cookie has already voted", () => {
    const result: PollResultView = {
      totalVotes: 980,
      hasFloor: true,
      pctA: 28,
      pctB: 72,
      divisiveness: 0.56,
      lastVoteAt: null,
    };
    const m = mount(
      <WirePollPanel
        storyId="s1"
        poll={makePoll({
          initialResult: result,
          initialVotedSide: "B",
        })}
      />,
    );

    // No choice buttons — we're past the vote.
    expect(findChoiceButton(m.container, "A")).toBeNull();
    expect(findChoiceButton(m.container, "B")).toBeNull();

    // Both result rows render, the user's side is highlighted.
    const highlighted = findResultRow(m.container, "B");
    expect(highlighted).not.toBeNull();
    expect(highlighted?.dataset.highlighted).toBe("true");
    expect(m.container.textContent).toContain("72%");
    expect(m.container.textContent).toContain("You're with the majority");

    unmount(m);
  });
});
