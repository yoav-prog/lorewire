// Coverage for the anonymous-identity cookie primitive.
// The cookies()-bound paths (readAnonToken / getOrIssueAnonToken /
// clearAnonToken) live behind next/headers and only run inside a Next
// request context — they're integration-tested via the /api/consent
// route. This file pins the pure-logic surface (token shape + entropy).

import { describe, expect, it } from "vitest";

import { ANON_COOKIE, newAnonToken } from "./anon";

describe("anon token", () => {
  it("exports the lw_anon cookie name expected by the route handlers", () => {
    expect(ANON_COOKIE).toBe("lw_anon");
  });

  it("emits a 64-character lower-hex string (256 bits of entropy)", () => {
    const tok = newAnonToken();
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different value on every call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(newAnonToken());
    expect(seen.size).toBe(200);
  });
});
