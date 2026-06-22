// TOTP (RFC 6238) for staff two-factor auth. Implemented on node:crypto — no
// dependency, no QR library (the enrollment UI shows the otpauth:// URI + the
// base32 secret for manual entry into an authenticator app). SHA-1, 6 digits,
// 30-second step, ±1 step verification window (clock-skew tolerance).
//
// Correctness is pinned against the RFC 6238 test vectors in totp.test.ts.
// Code comparison is constant-time.
//
// Plan: _plans/2026-06-22-admin-user-management.md (Phase 8).

import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DIGITS = 6;
const STEP_SEC = 30;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648 base32

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/** The current code for a secret at a given time (ms). Mostly for tests. */
export function totpCodeAt(secretBase32: string, timeMs: number): string {
  return hotp(base32Decode(secretBase32), Math.floor(timeMs / 1000 / STEP_SEC));
}

/** Verify a submitted 6-digit code against the secret, with a ±1 step window. */
export function verifyTotp(
  secretBase32: string,
  token: string,
  timeMs: number = Date.now(),
): boolean {
  const t = (token || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(t)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(timeMs / 1000 / STEP_SEC);
  for (let w = -1; w <= 1; w++) {
    if (constantTimeEqual(hotp(secret, counter + w), t)) return true;
  }
  return false;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** otpauth:// URI an authenticator app reads (paste/QR). */
export function otpauthUri(
  secretBase32: string,
  accountLabel: string,
  issuer = "LoreWire",
): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
