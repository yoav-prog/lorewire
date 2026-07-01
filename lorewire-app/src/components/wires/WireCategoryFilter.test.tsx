// @vitest-environment happy-dom

// Coverage for the Wires category filter: the funnel button, its active-count
// badge, and the multi-select panel wiring. Uses the createRoot pattern the
// other wires component tests use (no @testing-library set up).

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { WireCategoryFilter } from "./WireCategoryFilter";
import { GRANULAR_CATEGORIES } from "@/lib/categories/granular";

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

function mount(node: React.ReactElement): Mounted {
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

let mounted: Mounted | null = null;
afterEach(() => {
  if (mounted) {
    unmount(mounted);
    mounted = null;
  }
});

function trigger(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(
    'button[aria-label="Filter by category"]',
  )!;
}

describe("WireCategoryFilter", () => {
  it("renders the funnel button with no badge when nothing is selected", () => {
    mounted = mount(
      <WireCategoryFilter selected={[]} onToggle={() => {}} onClear={() => {}} />,
    );
    const btn = trigger(mounted.container);
    expect(btn).not.toBeNull();
    // The badge (a span with a number) is absent at zero selection.
    expect(btn.querySelector("span.bg-accent")).toBeNull();
    // Panel is closed until opened.
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows a count badge equal to the number of selected categories", () => {
    mounted = mount(
      <WireCategoryFilter
        selected={["workplace", "breakups"]}
        onToggle={() => {}}
        onClear={() => {}}
      />,
    );
    const badge = trigger(mounted.container).querySelector("span.bg-accent");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("2");
  });

  it("opens the panel with one chip per granular category and toggles on tap", () => {
    const toggled: string[] = [];
    mounted = mount(
      <WireCategoryFilter
        selected={[]}
        onToggle={(s) => toggled.push(s)}
        onClear={() => {}}
      />,
    );
    act(() => {
      trigger(mounted!.container).click();
    });
    const dialog = mounted.container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const chips = dialog!.querySelectorAll("button[data-slug]");
    expect(chips.length).toBe(GRANULAR_CATEGORIES.length);

    const workplace = dialog!.querySelector<HTMLButtonElement>(
      'button[data-slug="workplace"]',
    );
    expect(workplace).not.toBeNull();
    act(() => {
      workplace!.click();
    });
    expect(toggled).toEqual(["workplace"]);
  });

  it("marks selected chips aria-pressed and fires onClear from the panel", () => {
    let cleared = 0;
    mounted = mount(
      <WireCategoryFilter
        selected={["creepy"]}
        onToggle={() => {}}
        onClear={() => {
          cleared += 1;
        }}
      />,
    );
    act(() => {
      trigger(mounted!.container).click();
    });
    const creepy = mounted.container.querySelector<HTMLButtonElement>(
      'button[data-slug="creepy"]',
    );
    expect(creepy!.getAttribute("aria-pressed")).toBe("true");

    // "Clear" appears only when something is selected.
    const clearBtn = Array.from(
      mounted.container.querySelectorAll<HTMLButtonElement>(
        '[role="dialog"] button',
      ),
    ).find((b) => b.textContent?.trim() === "Clear");
    expect(clearBtn).toBeTruthy();
    act(() => {
      clearBtn!.click();
    });
    expect(cleared).toBe(1);
  });
});
