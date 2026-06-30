// @vitest-environment happy-dom

// ConditionalAnalytics is the consent gate for Google Analytics 4, Vercel
// Analytics, and Vercel Speed Insights. The contract that platform
// reviewers (and the Privacy Policy §3) rely on:
//
//   - consent === null      → render null (no scripts in DOM)
//   - consent === "rejected"→ render null
//   - consent === "accepted"→ render at least the Vercel Analytics +
//                              SpeedInsights children. GA4 also renders
//                              when NEXT_PUBLIC_GA_MEASUREMENT_ID is set.
//
// We mock `useConsent`, `usePathname`, and the Vercel + next/script
// components so the test can focus on the gating behavior without
// pulling in the real Next router or the analytics SDKs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

let consentValue: "accepted" | "rejected" | null = null;

vi.mock("@/lib/consent-client", () => ({
  useConsent: () => consentValue,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("next/script", () => ({
  default: ({ id }: { id: string; children?: React.ReactNode }) => (
    <div data-testid={`script-${id}`} />
  ),
}));

vi.mock("@vercel/analytics/next", () => ({
  Analytics: () => <div data-testid="vercel-analytics" />,
}));

vi.mock("@vercel/speed-insights/next", () => ({
  SpeedInsights: () => <div data-testid="vercel-speed-insights" />,
}));

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
  consentValue = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function importComponent() {
  // Dynamic import so the mocks above are in place before the
  // module is evaluated.
  const mod = await import("./ConditionalAnalytics");
  return mod.default;
}

describe("ConditionalAnalytics — gating", () => {
  it("renders nothing when consent is null (banner not answered)", async () => {
    const ConditionalAnalytics = await importComponent();
    consentValue = null;
    const m = mount(<ConditionalAnalytics />);
    expect(m.container.querySelector('[data-testid="vercel-analytics"]'))
      .toBeNull();
    expect(
      m.container.querySelector('[data-testid="vercel-speed-insights"]'),
    ).toBeNull();
    expect(m.container.children.length).toBe(0);
    unmount(m);
  });

  it("renders nothing when consent is rejected", async () => {
    const ConditionalAnalytics = await importComponent();
    consentValue = "rejected";
    const m = mount(<ConditionalAnalytics />);
    expect(m.container.querySelector('[data-testid="vercel-analytics"]'))
      .toBeNull();
    expect(
      m.container.querySelector('[data-testid="vercel-speed-insights"]'),
    ).toBeNull();
    expect(m.container.children.length).toBe(0);
    unmount(m);
  });

  it("renders Vercel Analytics + Speed Insights when consent is accepted", async () => {
    const ConditionalAnalytics = await importComponent();
    consentValue = "accepted";
    const m = mount(<ConditionalAnalytics />);
    expect(
      m.container.querySelector('[data-testid="vercel-analytics"]'),
    ).not.toBeNull();
    expect(
      m.container.querySelector('[data-testid="vercel-speed-insights"]'),
    ).not.toBeNull();
    unmount(m);
  });
});
