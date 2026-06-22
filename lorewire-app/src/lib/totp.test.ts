// TOTP correctness, pinned against RFC 6238 test vectors. The reference secret
// is the 20-byte ASCII "12345678901234567890", which is base32
// "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; the canonical 6-digit SHA-1 codes are
// 287082 at T=59s and 050471 at T=1111111111s. If our HOTP truncation or
// base32 decode were wrong, these would not match.

import { describe, expect, it } from "vitest";

import {
  generateTotpSecret,
  otpauthUri,
  totpCodeAt,
  verifyTotp,
} from "./totp";

const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("TOTP — RFC 6238 vectors", () => {
  it("produces 287082 at T=59s", () => {
    expect(totpCodeAt(RFC_SECRET, 59_000)).toBe("287082");
  });

  it("produces 050471 at T=1111111111s", () => {
    expect(totpCodeAt(RFC_SECRET, 1_111_111_111_000)).toBe("050471");
  });

  it("verifies the matching code at that time", () => {
    expect(verifyTotp(RFC_SECRET, "287082", 59_000)).toBe(true);
    expect(verifyTotp(RFC_SECRET, "050471", 1_111_111_111_000)).toBe(true);
  });
});

describe("verifyTotp", () => {
  it("accepts the previous/next step within the ±1 window", () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, now), now)).toBe(true);
    // Code from the previous 30s step still verifies (clock skew tolerance).
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, now - 30_000), now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, now + 30_000), now)).toBe(true);
  });

  it("rejects a code two steps away", () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, now - 90_000), now)).toBe(false);
  });

  it("rejects wrong / malformed codes", () => {
    expect(verifyTotp(RFC_SECRET, "000000", 59_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "12345", 59_000)).toBe(false); // too short
    expect(verifyTotp(RFC_SECRET, "abcdef", 59_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "", 59_000)).toBe(false);
  });
});

describe("generateTotpSecret + otpauthUri", () => {
  it("generates a usable base32 secret that round-trips through verify", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(16);
    const now = Date.now();
    expect(verifyTotp(secret, totpCodeAt(secret, now), now)).toBe(true);
  });

  it("builds an otpauth URI carrying the secret + issuer", () => {
    const uri = otpauthUri("ABCDEFGH", "alice@example.com", "LoreWire");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("secret=ABCDEFGH");
    expect(uri).toContain("issuer=LoreWire");
  });
});
