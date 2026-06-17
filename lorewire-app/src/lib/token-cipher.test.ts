// Tests for the AES-256-GCM token cipher.
//
// Coverage: round-trip, IV uniqueness, envelope shape, wrong-key rejection,
// tamper detection, key rotation (prev-key fallback), hex and base64 keys,
// malformed envelopes, and bad-key construction.

import { describe, expect, it } from "vitest";
import {
  TokenCipherError,
  createTokenCipher,
  type TokenCipherErrorCode,
} from "./token-cipher";

// Two distinct 256-bit test keys as 64 hex chars each.
const KEY_A = "a".repeat(64); // 0xaa x32
const KEY_B = "b".repeat(64); // 0xbb x32

function codeOf(fn: () => unknown): TokenCipherErrorCode | "no-throw" {
  try {
    fn();
    return "no-throw";
  } catch (e) {
    return e instanceof TokenCipherError ? e.code : "no-throw";
  }
}

describe("token-cipher", () => {
  it("round-trips a value with the right key", () => {
    const c = createTokenCipher({ current: KEY_A });
    const secret = "ya29.a0AfH6SMexample-access-token";
    expect(c.decrypt(c.encrypt(secret))).toBe(secret);
  });

  it("round-trips unicode and empty strings", () => {
    const c = createTokenCipher({ current: KEY_A });
    for (const s of ["", "סוד", "emoji 🎬 token", "a".repeat(5000)]) {
      expect(c.decrypt(c.encrypt(s))).toBe(s);
    }
  });

  it("produces a fresh envelope each call but both decrypt the same", () => {
    const c = createTokenCipher({ current: KEY_A });
    const a = c.encrypt("same");
    const b = c.encrypt("same");
    expect(a).not.toBe(b); // random IV per message
    expect(c.decrypt(a)).toBe("same");
    expect(c.decrypt(b)).toBe("same");
  });

  it("emits the lw1 five-part envelope shape", () => {
    const c = createTokenCipher({ current: KEY_A });
    const parts = c.encrypt("x").split(":");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("lw1");
    expect(parts[1]).toMatch(/^[0-9a-f]{8}$/); // key fingerprint
  });

  it("rejects an envelope sealed under an unknown key", () => {
    const a = createTokenCipher({ current: KEY_A });
    const b = createTokenCipher({ current: KEY_B });
    expect(codeOf(() => b.decrypt(a.encrypt("secret")))).toBe("unknown-key");
  });

  it("detects tampering with the ciphertext", () => {
    const c = createTokenCipher({ current: KEY_A });
    const env = c.encrypt("secret");
    const parts = env.split(":");
    // Flip a char in the ciphertext segment (still valid base64url).
    const ct = parts[4];
    parts[4] = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    expect(codeOf(() => c.decrypt(parts.join(":")))).toBe("auth-failed");
  });

  it("decrypts an old token via the prev-key slot after rotation", () => {
    // Seal under A while A is current.
    const old = createTokenCipher({ current: KEY_A });
    const env = old.encrypt("legacy-token");
    // Rotate: B is now current, A demoted to prev.
    const rotated = createTokenCipher({ current: KEY_B, prev: KEY_A });
    expect(rotated.decrypt(env)).toBe("legacy-token");
    // New writes seal under B.
    expect(rotated.decrypt(rotated.encrypt("new-token"))).toBe("new-token");
  });

  it("cannot read a new-key token with only the old key", () => {
    const rotated = createTokenCipher({ current: KEY_B, prev: KEY_A });
    const onlyOld = createTokenCipher({ current: KEY_A });
    expect(codeOf(() => onlyOld.decrypt(rotated.encrypt("x")))).toBe(
      "unknown-key",
    );
  });

  it("accepts a base64-encoded 32-byte key", () => {
    const base64Key = Buffer.alloc(32, 7).toString("base64");
    const c = createTokenCipher({ current: base64Key });
    expect(c.decrypt(c.encrypt("ok"))).toBe("ok");
  });

  it("rejects a malformed envelope", () => {
    const c = createTokenCipher({ current: KEY_A });
    expect(codeOf(() => c.decrypt("not-an-envelope"))).toBe("malformed");
    expect(codeOf(() => c.decrypt("lw1:deadbeef:aa:bb"))).toBe("malformed");
    expect(codeOf(() => c.decrypt("v9:deadbeef:a:b:c"))).toBe("malformed");
  });

  it("rejects a key of the wrong length at construction", () => {
    expect(codeOf(() => createTokenCipher({ current: "tooshort" }))).toBe(
      "bad-key",
    );
    expect(codeOf(() => createTokenCipher({ current: "a".repeat(63) }))).toBe(
      "bad-key",
    );
  });
});
