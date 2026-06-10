// Password hashing with Node's built-in scrypt (no native dependency). Stored
// as scrypt$<salt>$<hash>; verification is constant-time.

import "server-only";
import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  pw: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scryptAsync(pw, salt, KEYLEN);
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const derived = await scryptAsync(pw, salt, KEYLEN);
  const hashBuf = Buffer.from(hash, "hex");
  return hashBuf.length === derived.length && timingSafeEqual(hashBuf, derived);
}
