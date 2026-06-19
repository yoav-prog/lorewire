// @vitest-environment happy-dom

// Pure-logic coverage for the client-side consent helpers. The cookie
// parser and the grandfather detector are the surface this file
// guards — both feed the banner's "show or skip" decision, and a
// regression in either silently breaks the consent flow.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasGrandfatherableState } from "./consent-client";

function clearAllCookies(): void {
  for (const pair of document.cookie.split("; ")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name) document.cookie = `${name}=; Max-Age=0; path=/`;
  }
}

describe("hasGrandfatherableState", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearAllCookies();
  });
  afterEach(() => {
    window.localStorage.clear();
    clearAllCookies();
  });

  it("returns false when the browser has no prior persisted state", () => {
    expect(hasGrandfatherableState()).toBe(false);
  });

  it("returns true when lw.saved.v1 has any entries", () => {
    window.localStorage.setItem("lw.saved.v1", JSON.stringify(["s_one"]));
    expect(hasGrandfatherableState()).toBe(true);
  });

  it("returns true when lw.liked.v1 has any entries", () => {
    window.localStorage.setItem("lw.liked.v1", JSON.stringify(["s_two"]));
    expect(hasGrandfatherableState()).toBe(true);
  });

  it("treats empty arrays as no-state — those rows wrote 0 entries", () => {
    window.localStorage.setItem("lw.saved.v1", "[]");
    window.localStorage.setItem("lw.liked.v1", "[]");
    expect(hasGrandfatherableState()).toBe(false);
  });

  it("returns true when the lw_vote poll cookie is already present", () => {
    document.cookie = "lw_vote=deadbeef; path=/";
    expect(hasGrandfatherableState()).toBe(true);
  });
});
