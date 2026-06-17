// Tests for the pure publish-domain helpers.

import { describe, expect, it } from "vitest";
import {
  audioClearanceGate,
  nextRetryDelayMs,
  type AudioSource,
} from "./social-publish";

describe("audioClearanceGate", () => {
  it("allows every publishable source and echoes the verdict", () => {
    const sources: AudioSource[] = [
      "silence",
      "tts",
      "platform_library",
      "rights_attested",
    ];
    for (const source of sources) {
      const r = audioClearanceGate({ source, platform: "youtube" });
      expect(r.allowed).toBe(true);
      expect(r.verdict).toBe(source);
    }
  });

  it("blocks unknown provenance", () => {
    const r = audioClearanceGate({ source: "unknown", platform: "youtube" });
    expect(r.allowed).toBe(false);
    expect(r.verdict).toBe("blocked");
    expect(r.reason).toMatch(/unknown/i);
  });

  it("blocks consumer-library audio on TikTok with the Commercial Sound Library hint", () => {
    const r = audioClearanceGate({
      source: "consumer_library",
      platform: "tiktok",
    });
    expect(r.allowed).toBe(false);
    expect(r.verdict).toBe("blocked");
    expect(r.reason).toMatch(/commercial sound library/i);
  });

  it("blocks consumer-library audio on other platforms too", () => {
    const r = audioClearanceGate({
      source: "consumer_library",
      platform: "youtube",
    });
    expect(r.allowed).toBe(false);
    expect(r.verdict).toBe("blocked");
  });
});

describe("nextRetryDelayMs", () => {
  it("grows exponentially from the base delay", () => {
    expect(nextRetryDelayMs(1)).toBe(1000);
    expect(nextRetryDelayMs(2)).toBe(2000);
    expect(nextRetryDelayMs(3)).toBe(4000);
    expect(nextRetryDelayMs(4)).toBe(8000);
    expect(nextRetryDelayMs(5)).toBe(16000);
  });

  it("gives up once the attempt cap is reached", () => {
    expect(nextRetryDelayMs(6)).toBeNull(); // default maxAttempts = 6
    expect(nextRetryDelayMs(7)).toBeNull();
    expect(nextRetryDelayMs(0)).toBeNull();
    expect(nextRetryDelayMs(-1)).toBeNull();
  });

  it("caps the computed delay", () => {
    expect(nextRetryDelayMs(5, { capMs: 5000 })).toBe(5000);
  });

  it("treats Retry-After as a floor", () => {
    expect(nextRetryDelayMs(1, { retryAfterMs: 30000 })).toBe(30000);
    expect(nextRetryDelayMs(4, { retryAfterMs: 1000 })).toBe(8000);
  });

  it("honors a custom maxAttempts", () => {
    expect(nextRetryDelayMs(2, { maxAttempts: 3 })).toBe(2000);
    expect(nextRetryDelayMs(3, { maxAttempts: 3 })).toBeNull();
  });
});
