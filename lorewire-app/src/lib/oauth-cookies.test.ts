// sanitizeNext coverage. The path validator is the open-redirect guard
// between an OAuth callback and the post-sign-in redirect target. Any
// regression here lets an attacker craft a sign-in link that lands the
// user on attacker.com after a successful sign-in — single most
// dangerous bug in the auth flow's response surface.

import { describe, expect, it } from "vitest";

import { sanitizeNext } from "./oauth-cookies";

describe("sanitizeNext", () => {
  it("accepts a simple absolute path", () => {
    expect(sanitizeNext("/")).toBe("/");
    expect(sanitizeNext("/articles")).toBe("/articles");
    expect(sanitizeNext("/v/some-slug")).toBe("/v/some-slug");
  });

  it("accepts query strings on a same-origin path", () => {
    expect(sanitizeNext("/search?q=test")).toBe("/search?q=test");
  });

  it("rejects null + empty + whitespace", () => {
    expect(sanitizeNext(null)).toBeNull();
    expect(sanitizeNext("")).toBeNull();
    expect(sanitizeNext("   ")).toBeNull();
    expect(sanitizeNext(undefined)).toBeNull();
  });

  it("rejects fully-qualified URLs", () => {
    expect(sanitizeNext("https://lorewire.com/foo")).toBeNull();
    expect(sanitizeNext("http://localhost/foo")).toBeNull();
  });

  it("rejects protocol-relative URLs (the open-redirect classic)", () => {
    expect(sanitizeNext("//attacker.com/")).toBeNull();
    expect(sanitizeNext("//attacker.com/path?q=x")).toBeNull();
  });

  it("rejects backslash-trick attempts", () => {
    expect(sanitizeNext("/\\attacker.com")).toBeNull();
  });

  it("rejects javascript: and data: schemes embedded after a slash", () => {
    // The regex blocks colons in the path, so these die at the first
    // disallowed char.
    expect(sanitizeNext("/javascript:alert(1)")).toBeNull();
    expect(sanitizeNext("/data:text/html,foo")).toBeNull();
  });

  it("rejects paths not anchored with a leading slash", () => {
    expect(sanitizeNext("articles")).toBeNull();
    expect(sanitizeNext("articles/foo")).toBeNull();
  });
});
