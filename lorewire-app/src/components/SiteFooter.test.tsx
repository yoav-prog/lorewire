// @vitest-environment happy-dom

// SiteFooter coverage:
//   1. All seven new trust pages are linked.
//   2. The Manage cookies button dispatches the lw:consent:reopen
//      custom event the CookieConsent banner listens for, so the
//      reopener actually works.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import SiteFooter from "./SiteFooter";

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

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SiteFooter — trust links", () => {
  it("links to every required trust page", () => {
    const m = mount(<SiteFooter />);
    const hrefs = Array.from(
      m.container.querySelectorAll("a"),
    ).map((a) => a.getAttribute("href"));
    for (const expected of [
      "/faq",
      "/contact",
      "/accessibility",
      "/privacy",
      "/terms",
      "/cookie-policy",
      "/dmca",
      "/about",
      "/community-guidelines",
    ]) {
      expect(hrefs).toContain(expected);
    }
    unmount(m);
  });

  it("renders the LoreWire wordmark and the © year", () => {
    const m = mount(<SiteFooter />);
    expect(m.container.textContent).toContain("LORE");
    expect(m.container.textContent).toContain("WIRE");
    const thisYear = new Date().getUTCFullYear();
    expect(m.container.textContent).toContain(String(thisYear));
    unmount(m);
  });
});

describe("SiteFooter — Manage cookies reopener", () => {
  it("fires the lw:consent:reopen custom event when the button is clicked", () => {
    const m = mount(<SiteFooter />);
    const listener = vi.fn();
    window.addEventListener("lw:consent:reopen", listener);

    const btn = Array.from(
      m.container.querySelectorAll("button"),
    ).find((b) => b.textContent?.toLowerCase().includes("manage cookies"));
    expect(btn).toBeDefined();

    act(() => {
      btn!.click();
    });

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener("lw:consent:reopen", listener);
    unmount(m);
  });
});
