// Pure-logic tests for the render_short dispatcher's helpers. The
// integration path (claim row → POST Cloud Run → mark done) is exercised
// by manual smoke against the live dispatcher; here we lock down only
// the parsing seam where bugs would silently break the hook-first splice.
//
// _plans/2026-06-28-hook-before-brand-intro.md.

import { describe, expect, it } from "vitest";
import { extractHookEndSecFromProps } from "./route";

describe("extractHookEndSecFromProps", () => {
  it("returns hookEndSec in seconds when hook_end_ms is a positive number", () => {
    const props = { hook_end_ms: 2500, voiceover_url: "x.mp3" };
    const result = extractHookEndSecFromProps(props);
    expect(result.hookEndSec).toBe(2.5);
    expect(result.propsStripped).toBe(true);
    // Strip removes the key so Remotion never sees a phantom prop.
    expect("hook_end_ms" in props).toBe(false);
    // Everything else passes through untouched.
    expect(props.voiceover_url).toBe("x.mp3");
  });

  it("returns null when hook_end_ms is missing", () => {
    const props = { voiceover_url: "x.mp3" };
    const result = extractHookEndSecFromProps(props);
    expect(result.hookEndSec).toBeNull();
    expect(result.propsStripped).toBe(false);
  });

  it("returns null but still strips the key when hook_end_ms is malformed", () => {
    // Even invalid values get stripped so they can't pollute the
    // Remotion props. The splice just falls back to legacy ordering.
    for (const bad of [0, -100, NaN, Infinity, "2500", null, false]) {
      const props: Record<string, unknown> = { hook_end_ms: bad };
      const result = extractHookEndSecFromProps(props);
      expect(result.hookEndSec, `value=${JSON.stringify(bad)}`).toBeNull();
      expect(result.propsStripped, `value=${JSON.stringify(bad)}`).toBe(true);
      expect("hook_end_ms" in props).toBe(false);
    }
  });

  it("returns null when inputProps is not an object", () => {
    for (const bad of [null, undefined, 42, "props", []]) {
      const result = extractHookEndSecFromProps(bad);
      expect(result.hookEndSec, `value=${JSON.stringify(bad)}`).toBeNull();
      expect(result.propsStripped, `value=${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("does not mutate inputProps when hook_end_ms is absent", () => {
    const props = { voiceover_url: "x.mp3", end_hold_ms: 1500 };
    const before = JSON.stringify(props);
    extractHookEndSecFromProps(props);
    expect(JSON.stringify(props)).toBe(before);
  });
});
