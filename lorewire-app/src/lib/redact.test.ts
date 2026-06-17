// Tests for the log redaction guard.

import { describe, expect, it } from "vitest";
import { redact } from "./redact";

describe("redact", () => {
  it("redacts default sensitive keys at the top level", () => {
    const out = redact({
      access_token: "ya29.secret",
      refresh_token: "1//secret",
      authorization: "Bearer secret",
      cookie: "session=abc",
      platform: "youtube",
    });
    expect(out).toEqual({
      access_token: "[REDACTED]",
      refresh_token: "[REDACTED]",
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      platform: "youtube",
    });
  });

  it("redacts nested keys and inside arrays", () => {
    const out = redact({
      account: { id: "a1", access_token: "secret" },
      jobs: [{ id: "j1", refresh_token: "secret" }, { id: "j2" }],
    });
    expect(out).toEqual({
      account: { id: "a1", access_token: "[REDACTED]" },
      jobs: [{ id: "j1", refresh_token: "[REDACTED]" }, { id: "j2" }],
    });
  });

  it("matches key names case-insensitively", () => {
    const out = redact({ Authorization: "x", ACCESS_TOKEN: "y" });
    expect(out).toEqual({
      Authorization: "[REDACTED]",
      ACCESS_TOKEN: "[REDACTED]",
    });
  });

  it("replaces a sensitive key wholesale even when its value is an object", () => {
    const out = redact({ access_token: { jwt: "header.payload.sig" } });
    expect(out).toEqual({ access_token: "[REDACTED]" });
  });

  it("leaves non-sensitive values intact", () => {
    const input = { id: "x", count: 3, ok: true, nested: { a: 1 } };
    expect(redact(input)).toEqual(input);
  });

  it("does not mutate the input", () => {
    const input = { access_token: "secret", nested: { cookie: "c" } };
    const snapshot = JSON.parse(JSON.stringify(input));
    redact(input);
    expect(input).toEqual(snapshot);
  });

  it("supports a custom sensitive-key list", () => {
    const out = redact({ ssn: "123", name: "x" }, ["ssn"]);
    expect(out).toEqual({ ssn: "[REDACTED]", name: "x" });
  });

  it("handles circular references without throwing", () => {
    const a: Record<string, unknown> = { id: "a" };
    a.self = a;
    const out = redact(a) as Record<string, unknown>;
    expect(out.id).toBe("a");
    expect(out.self).toBe("[Circular]");
  });

  it("passes primitives through unchanged", () => {
    expect(redact("hello")).toBe("hello");
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
  });
});
