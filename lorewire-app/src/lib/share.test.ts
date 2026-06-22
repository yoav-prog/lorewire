// Tests for the share helper — the single share path behind the Reels feed and
// the homepage detail modals. The contract that matters: build only public
// /v/[slug] URLs, prefer the native sheet, fall back to clipboard, and NEVER
// copy-on-dismiss (a thrown native share must not silently land in the
// clipboard and flash a false "Copied").

import { afterEach, describe, expect, it, vi } from "vitest";

import { shareOrCopy, storyShareUrl } from "./share";

const ORIGIN = "https://lorewire.com";

describe("storyShareUrl", () => {
  it("builds the public /v/[slug] reader URL", () => {
    expect(storyShareUrl("the-800-envelope", ORIGIN)).toBe(
      "https://lorewire.com/v/the-800-envelope",
    );
  });

  it("falls back to the bare origin when there is no public slug", () => {
    expect(storyShareUrl(null, ORIGIN)).toBe(ORIGIN);
    expect(storyShareUrl(undefined, ORIGIN)).toBe(ORIGIN);
    expect(storyShareUrl("", ORIGIN)).toBe(ORIGIN);
  });
});

describe("shareOrCopy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the native share sheet when available", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share, clipboard: { writeText } });

    const outcome = await shareOrCopy({ url: `${ORIGIN}/v/a`, title: "A" });

    expect(outcome).toBe("shared");
    expect(share).toHaveBeenCalledWith({ title: "A", url: `${ORIGIN}/v/a` });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to clipboard when Web Share is missing", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const outcome = await shareOrCopy({ url: `${ORIGIN}/v/b` });

    expect(outcome).toBe("copied");
    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}/v/b`);
  });

  it("does NOT copy when the native sheet is dismissed", async () => {
    const share = vi.fn().mockRejectedValue(new Error("AbortError"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share, clipboard: { writeText } });

    const outcome = await shareOrCopy({ url: `${ORIGIN}/v/c` });

    expect(outcome).toBe("unavailable");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reports unavailable when clipboard write is denied", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const outcome = await shareOrCopy({ url: `${ORIGIN}/v/d` });

    expect(outcome).toBe("unavailable");
  });
});
