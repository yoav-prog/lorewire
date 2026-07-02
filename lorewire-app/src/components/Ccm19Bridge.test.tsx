// @vitest-environment happy-dom

// Ccm19Bridge coverage:
//   1. Mount-time sync: an already-initialized CCM19 with full consent
//      POSTs "accepted" to /api/consent.
//   2. No POST while CCM19 is absent or the visitor is undecided
//      (fail-closed), then a ccm19WidgetClosed event after a saved
//      rejection POSTs "rejected".
//   3. No POST when lw_consent already matches the CCM19 state
//      (idempotence — ccm19EmbeddingAccepted fires on every pageload).
//   4. The footer's lw:consent:reopen event opens the CCM19 widget.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Ccm19Bridge from "./Ccm19Bridge";

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

/** Flush the bridge's async sync (fetch + await) inside act. A macrotask
 *  hop guarantees the whole microtask chain (sync → setConsentClient →
 *  fetch) has settled before assertions run. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const fetchMock = vi.fn<typeof fetch>(async () => ({ ok: true }) as Response);

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockClear();
  delete window.CCM;
  document.cookie = "lw_consent=; Max-Age=0";
  window.localStorage.clear();
});

function postedValues(): string[] {
  return fetchMock.mock.calls.map((call) => {
    const init = call[1] as RequestInit | undefined;
    return (JSON.parse(String(init?.body)) as { value: string }).value;
  });
}

describe("Ccm19Bridge — consent sync", () => {
  it("POSTs accepted when CCM19 initialized with full consent before mount", async () => {
    window.CCM = { consent: true, fullConsentGiven: true };
    const m = mount(<Ccm19Bridge />);
    await flush();
    expect(postedValues()).toEqual(["accepted"]);
    unmount(m);
  });

  it("stays quiet without CCM19, then POSTs rejected after a saved rejection", async () => {
    const m = mount(<Ccm19Bridge />);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    window.CCM = {
      consent: true,
      fullConsentGiven: false,
      acceptedEmbeddings: [],
    };
    act(() => {
      window.dispatchEvent(new Event("ccm19WidgetClosed"));
    });
    await flush();
    expect(postedValues()).toEqual(["rejected"]);
    unmount(m);
  });

  it("does not POST when the cookie already matches", async () => {
    document.cookie = "lw_consent=accepted";
    window.CCM = { consent: true, fullConsentGiven: true };
    const m = mount(<Ccm19Bridge />);
    await flush();
    act(() => {
      window.dispatchEvent(new Event("ccm19EmbeddingAccepted"));
    });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    unmount(m);
  });

  it("does not POST while the visitor is undecided", async () => {
    window.CCM = { consent: false };
    const m = mount(<Ccm19Bridge />);
    await flush();
    act(() => {
      window.dispatchEvent(new Event("ccm19WidgetLoaded"));
    });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    unmount(m);
  });
});

describe("Ccm19Bridge — Manage cookies reopener", () => {
  it("opens the CCM19 widget on lw:consent:reopen", () => {
    const openWidget = vi.fn();
    window.CCM = { openWidget };
    const m = mount(<Ccm19Bridge />);
    act(() => {
      window.dispatchEvent(new CustomEvent("lw:consent:reopen"));
    });
    expect(openWidget).toHaveBeenCalledTimes(1);
    unmount(m);
  });

  it("warns instead of throwing when CCM19 is unavailable", () => {
    const m = mount(<Ccm19Bridge />);
    act(() => {
      window.dispatchEvent(new CustomEvent("lw:consent:reopen"));
    });
    expect(console.warn).toHaveBeenCalledWith(
      "[consent ccm19] reopen-unavailable",
      expect.anything(),
    );
    unmount(m);
  });
});
