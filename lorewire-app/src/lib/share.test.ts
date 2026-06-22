// Tests for the share helpers — the single share path behind the Wires feed and
// the homepage detail modals. The contract that matters: build only public
// /v/[slug] URLs, and produce correctly-encoded per-platform deep links (we
// deliberately do NOT use the Web Share API / OS share panel).

import { afterEach, describe, expect, it, vi } from "vitest";

import { copyToClipboard, shareTargets, storyShareUrl } from "./share";

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

describe("shareTargets", () => {
  const url = "https://lorewire.com/v/the-800-envelope";
  const title = "The $800 Envelope";
  const targets = shareTargets(url, title);

  it("returns the six expected platforms in order", () => {
    expect(targets.map((t) => t.id)).toEqual([
      "whatsapp",
      "x",
      "facebook",
      "telegram",
      "linkedin",
      "email",
    ]);
  });

  it("URL-encodes the link and title into each deep link", () => {
    const enc = encodeURIComponent(url);
    const fb = targets.find((t) => t.id === "facebook");
    const x = targets.find((t) => t.id === "x");
    expect(fb?.href).toBe(
      `https://www.facebook.com/sharer/sharer.php?u=${enc}`,
    );
    expect(x?.href).toContain(`url=${enc}`);
    // The "$" and space in the title must be percent-encoded, not raw.
    expect(x?.href).toContain(encodeURIComponent(title));
    expect(x?.href).not.toContain(" ");
    expect(x?.href).not.toContain("$");
  });

  it("uses wa.me + mailto schemes for WhatsApp and Email", () => {
    expect(targets.find((t) => t.id === "whatsapp")?.href).toMatch(
      /^https:\/\/wa\.me\/\?text=/,
    );
    expect(targets.find((t) => t.id === "email")?.href).toMatch(/^mailto:\?/);
  });
});

describe("copyToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes to the clipboard and returns true", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyToClipboard(`${ORIGIN}/v/a`)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}/v/a`);
  });

  it("returns false when the clipboard is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(copyToClipboard(`${ORIGIN}/v/b`)).resolves.toBe(false);
  });

  it("returns false when the write is denied", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyToClipboard(`${ORIGIN}/v/c`)).resolves.toBe(false);
  });
});
