// AES-256-GCM cipher for OAuth tokens at rest.
//
// Social OAuth access and refresh tokens never sit in the DB as plaintext
// (_plans/2026-06-16-multi-platform-shorts-publisher.md, sections 8/10/N3).
// Each token is sealed with AES-256-GCM under LOREWIRE_TOKEN_KEY before it
// reaches social_accounts, and is only ever decrypted inside a server route or
// worker (never shipped to the browser).
//
// Envelope, stored as TEXT (base64url throughout so it round-trips on both
// SQLite and Postgres without needing a BYTEA column):
//
//   lw1:<keyFingerprint>:<iv>:<tag>:<ciphertext>
//
//   lw1             format version, so the scheme can change later without a
//                   data migration
//   keyFingerprint  first 8 hex of SHA-256(key); picks the right key on decrypt
//                   so rotation works: a token sealed under the old key keeps
//                   decrypting after the old key moves to LOREWIRE_TOKEN_KEY_PREV
//   iv              96-bit random nonce, fresh per encryption (NIST SP 800-38D)
//   tag             128-bit GCM auth tag, for tamper detection
//
// Best practice checked 2026-06-17: 12-byte random IV per message, 16-byte tag,
// key held in env, iv + tag + key id stored alongside the ciphertext.
//
// The key is a 256-bit secret supplied as 64 hex chars or base64 (32 bytes).
// Generate one with: openssl rand -hex 32

import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const VERSION = "lw1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type TokenCipherErrorCode =
  | "missing-key"
  | "bad-key"
  | "malformed"
  | "unknown-key"
  | "auth-failed";

export class TokenCipherError extends Error {
  readonly code: TokenCipherErrorCode;
  constructor(code: TokenCipherErrorCode, message: string) {
    super(message);
    this.name = "TokenCipherError";
    this.code = code;
  }
}

export interface TokenCipher {
  encrypt(plaintext: string): string;
  decrypt(envelope: string): string;
}

// 32 bits of SHA-256 over the key. One-way and truncated so it reveals nothing
// useful, and stable across the current/prev rename, which makes it the right
// discriminator for which key sealed a given envelope.
function fingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function parseKey(raw: string, slot: string): Buffer {
  const t = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, "hex");
  const b = Buffer.from(t, "base64");
  if (b.length === KEY_BYTES) return b;
  throw new TokenCipherError(
    "bad-key",
    `${slot} must be a 256-bit key: 64 hex chars, or base64 of 32 bytes`,
  );
}

export function createTokenCipher(opts: {
  current: string;
  prev?: string | null;
}): TokenCipher {
  const current = parseKey(opts.current, "LOREWIRE_TOKEN_KEY");
  const currentLabel = fingerprint(current);

  // fingerprint -> key, so decrypt can pick whichever key sealed the row.
  const byLabel = new Map<string, Buffer>([[currentLabel, current]]);
  if (opts.prev) {
    const prev = parseKey(opts.prev, "LOREWIRE_TOKEN_KEY_PREV");
    const prevLabel = fingerprint(prev);
    // current wins if both env slots somehow hold the same key.
    if (!byLabel.has(prevLabel)) byLabel.set(prevLabel, prev);
  }

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGO, current, iv);
      const ct = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return [
        VERSION,
        currentLabel,
        iv.toString("base64url"),
        tag.toString("base64url"),
        ct.toString("base64url"),
      ].join(":");
    },

    decrypt(envelope: string): string {
      const parts = envelope.split(":");
      if (parts.length !== 5 || parts[0] !== VERSION) {
        throw new TokenCipherError("malformed", "unrecognized token envelope");
      }
      const [, label, ivB64, tagB64, ctB64] = parts;
      const key = byLabel.get(label);
      if (!key) {
        throw new TokenCipherError(
          "unknown-key",
          "token sealed under a key absent from LOREWIRE_TOKEN_KEY[_PREV]",
        );
      }
      const iv = Buffer.from(ivB64, "base64url");
      const tag = Buffer.from(tagB64, "base64url");
      const ct = Buffer.from(ctB64, "base64url");
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new TokenCipherError("malformed", "bad iv or tag length");
      }
      const decipher = createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([
          decipher.update(ct),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // final() throws when the tag fails to verify: tampering or wrong key.
        throw new TokenCipherError(
          "auth-failed",
          "token failed authentication",
        );
      }
    },
  };
}

// Env-backed singleton for app code. Tests call createTokenCipher directly with
// injected keys so they never touch process.env.
let cached: TokenCipher | null = null;

export function tokenCipher(): TokenCipher {
  if (cached) return cached;
  const current = process.env.LOREWIRE_TOKEN_KEY;
  if (!current) {
    throw new TokenCipherError("missing-key", "LOREWIRE_TOKEN_KEY is not set");
  }
  cached = createTokenCipher({
    current,
    prev: process.env.LOREWIRE_TOKEN_KEY_PREV ?? null,
  });
  return cached;
}
