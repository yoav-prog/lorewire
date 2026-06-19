// Public-side users repo. Reads and writes the `users` table for OAuth +
// magic-link sign-ins. The original `users` table predates this work and
// stored admin staff (email + password_hash + role); the Phase 1 schema
// migration added the columns needed for public users (name, picture_url,
// provider, provider_sub, anonymous_id, last_seen_at) without disturbing
// the admin rows. See src/lib/schema.ts USERS for the column list.
//
// Identity resolution on sign-in (the one operation that has to be exactly
// right):
//
//   1. Lookup by (provider, provider_sub) — the strongest identity key.
//      Google's `sub` claim is stable per Google account; Microsoft's `oid`
//      claim is stable per Microsoft account. If found → that's the user.
//
//   2. Fall back to lookup by lowercased email — covers cross-provider
//      account merge (user signed up with Google, later signs in with
//      Microsoft on the same email). If found AND the existing row has a
//      role of 'user' → link the new provider in place by setting
//      provider + provider_sub. If the existing row is an admin row
//      (role='admin' or has password_hash), REFUSE the link — that
//      would be a silent admin escalation and is the single worst-case
//      outcome here.
//
//   3. Create a new row with provider, provider_sub, email, name,
//      picture_url, anonymous_id (the prior lw_anon cookie value if the
//      browser had one), role='user'.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §Sign-in flow.

import "server-only";
import { randomUUID } from "node:crypto";

import { all, one, run } from "@/lib/db";

export type UserProvider = "google" | "microsoft" | "magic_link";

export interface UserRow {
  id: string;
  email: string;
  role: string;
  password_hash: string | null;
  name: string | null;
  picture_url: string | null;
  provider: UserProvider | null;
  provider_sub: string | null;
  anonymous_id: string | null;
  last_seen_at: string | null;
  created_at: string | null;
}

/** Normalize an email for storage + lookup. Email lookup compares the
 *  local-part case-insensitively; Gmail treats it that way and most
 *  providers send the canonical form anyway, but we don't want a
 *  case-flip to spawn a duplicate row. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export async function getUserById(id: string): Promise<UserRow | null> {
  if (!id) return null;
  return (await one<UserRow>("SELECT * FROM users WHERE id = ?", [id])) ?? null;
}

export async function getUserByProvider(
  provider: UserProvider,
  providerSub: string,
): Promise<UserRow | null> {
  if (!providerSub) return null;
  return (
    (await one<UserRow>(
      "SELECT * FROM users WHERE provider = ? AND provider_sub = ?",
      [provider, providerSub],
    )) ?? null
  );
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return (
    (await one<UserRow>("SELECT * FROM users WHERE email = ?", [normalized])) ??
    null
  );
}

/** Sign-in entry point. Identity inputs from the OAuth callback (or magic
 *  link verification): provider + provider_sub + email + optional name/picture
 *  + the browser's prior anonymous_id cookie value.
 *
 *  Returns the user row, plus a flag indicating whether this was a NEW
 *  user (created this request) — Phase 3 uses that to decide whether to
 *  run the poll-vote reconciliation step (only worth doing when there's a
 *  prior anonymous_id to stitch). */
export interface SignInIdentity {
  provider: UserProvider;
  providerSub: string;
  email: string;
  name?: string | null;
  pictureUrl?: string | null;
  /** The prior `lw_anon` cookie value if present, else null. */
  anonymousId: string | null;
}

export interface SignInResult {
  user: UserRow;
  /** True when this request created the row (vs found / linked an existing one). */
  created: boolean;
  /** True when an existing row was found by email and the provider was
   *  newly linked (cross-provider merge). */
  linked: boolean;
}

/** This is the single function that has to be exactly right. See module
 *  header for the three-step identity resolution. */
export async function upsertUserOnSignIn(
  identity: SignInIdentity,
): Promise<SignInResult> {
  const email = normalizeEmail(identity.email);
  if (!email) {
    throw new Error("upsertUserOnSignIn: email is required");
  }

  // Step 1: provider+sub lookup. Strongest identity match.
  const byProvider = await getUserByProvider(
    identity.provider,
    identity.providerSub,
  );
  if (byProvider) {
    await touchLastSeen(byProvider.id);
    return { user: byProvider, created: false, linked: false };
  }

  // Step 2: email lookup. Cross-provider merge candidate.
  const byEmail = await getUserByEmail(email);
  if (byEmail) {
    // Defense (rule 13): NEVER auto-link an admin row to an OAuth /
    // magic-link identity. Admin rows carry password_hash and role
    // values other than 'user'; if we let an attacker who controls the
    // matching email sign in through OAuth and then auto-link to the
    // admin row, the OAuth session would gain the admin role's
    // privileges. We refuse the link and surface a clear error — the
    // human admin can resolve it manually via the existing admin tools.
    if (byEmail.role !== "user") {
      console.warn("[auth users link-refused-admin]", {
        user_id_hash: hashForLog(byEmail.id),
        provider: identity.provider,
      });
      throw new Error(
        "An account with this email already exists with a different role. Contact support.",
      );
    }
    await run(
      `UPDATE users
         SET provider = ?,
             provider_sub = ?,
             name = COALESCE(name, ?),
             picture_url = COALESCE(picture_url, ?),
             last_seen_at = ?
       WHERE id = ?`,
      [
        identity.provider,
        identity.providerSub,
        identity.name ?? null,
        identity.pictureUrl ?? null,
        new Date().toISOString(),
        byEmail.id,
      ],
    );
    const linked = await getUserById(byEmail.id);
    if (!linked) throw new Error("user vanished after link");
    return { user: linked, created: false, linked: true };
  }

  // Step 3: create.
  const id = randomUUID();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO users
        (id, email, role, password_hash, name, picture_url,
         provider, provider_sub, anonymous_id, last_seen_at, created_at)
      VALUES (?, ?, 'user', NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      email,
      identity.name ?? null,
      identity.pictureUrl ?? null,
      identity.provider,
      identity.providerSub,
      identity.anonymousId,
      now,
      now,
    ],
  );
  const created = await getUserById(id);
  if (!created) throw new Error("user vanished after insert");
  console.info("[auth users created]", {
    user_id_hash: hashForLog(id),
    provider: identity.provider,
    anon_present: identity.anonymousId !== null,
  });
  return { user: created, created: true, linked: false };
}

async function touchLastSeen(userId: string): Promise<void> {
  await run("UPDATE users SET last_seen_at = ? WHERE id = ?", [
    new Date().toISOString(),
    userId,
  ]);
}

/** First 8 hex chars of a one-way hash. Safe to log per rule 13 (no
 *  reversible PII). Stable across logs for the same user so support
 *  can correlate without exposing the raw id. */
export function hashForLog(value: string): string {
  // Lazy crypto require — keeps the import graph clean for type-only
  // consumers. The hash is non-secret; SHA-256 is fine.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 8);
}

/** List recent users — admin convenience for the future user-management
 *  surface. Bounded and ordered by last_seen_at so the most-active are
 *  the first hit. */
export async function listRecentUsers(limit = 50): Promise<UserRow[]> {
  return await all<UserRow>(
    `SELECT * FROM users
      WHERE role = 'user'
      ORDER BY COALESCE(last_seen_at, created_at) DESC
      LIMIT ?`,
    [Math.max(1, Math.min(500, Math.floor(limit)))],
  );
}
