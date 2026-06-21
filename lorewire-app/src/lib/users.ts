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
import { hashPassword, verifyPassword } from "@/lib/passwords";

export type UserProvider =
  | "google"
  | "microsoft"
  | "reddit"
  | "magic_link"
  /** Email + password ("old fashion sign up"). Distinct from magic_link
   *  because magic_link proves email ownership (the user clicked a link
   *  sent to that inbox) while plain email/password does NOT — that
   *  distinction drives the cross-provider link refusal in
   *  upsertUserOnSignIn below (the squatter-guard). */
  | "email";

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
    // Squatter guard (2026-06-21): an email+password row was created
    // without proving the signer owns the email — anyone can type
    // someone-elses@gmail.com into the signup form. If we let a Google
    // OAuth identity for that same email LINK to the squatter's row,
    // the squatter's password still works and they retain access to
    // "the real user's" account.
    //
    // Refuse the link instead. The signing-in user gets a clear error;
    // the right resolution is for the real owner to sign in via their
    // OAuth provider, which creates a fresh row, and contact support
    // if the abandoned squatter row needs cleanup. Magic-link rows
    // DON'T trip this — clicking a magic link proves the same email
    // ownership that an OAuth identity proves, so cross-linking
    // between magic_link and OAuth is safe.
    if (byEmail.provider === "email" && identity.provider !== "email") {
      console.warn("[auth users link-refused-email-row]", {
        user_id_hash: hashForLog(byEmail.id),
        attempted_provider: identity.provider,
      });
      throw new Error(
        "An account with this email already exists. Sign in with your password instead.",
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

/** Editable profile fields. Email is NOT editable here — it's the
 *  identity anchor for OAuth + magic link and changing it would orphan
 *  every existing sign-in path. A future "request email change" flow
 *  (verify the new address before swapping) is the right way to do that,
 *  out of scope for v1. */
export interface ProfilePatch {
  name?: string | null;
  pictureUrl?: string | null;
}

const NAME_MAX_LEN = 64;
const URL_MAX_LEN = 512;
const URL_HTTP_RE = /^https?:\/\//i;

/** Sanitize a profile patch and apply it. Returns the updated row.
 *  Throws when the user doesn't exist. Validation lives here (not just
 *  on the API route) so direct callers (tests, server actions) get
 *  the same guarantees. */
export async function updateUserProfile(
  userId: string,
  patch: ProfilePatch,
): Promise<UserRow> {
  if (!userId) throw new Error("updateUserProfile: userId required");
  const existing = await getUserById(userId);
  if (!existing) throw new Error("updateUserProfile: user not found");

  const sets: string[] = [];
  const params: unknown[] = [];

  if (Object.prototype.hasOwnProperty.call(patch, "name")) {
    let name = patch.name;
    if (typeof name === "string") {
      name = name.trim();
      if (name.length > NAME_MAX_LEN) {
        throw new Error("Name is too long.");
      }
      // Allow letters, marks (covers Hebrew + Arabic + accents), digits,
      // spaces, apostrophes, hyphens, periods. Anything else is rejected
      // so we don't accept HTML or control characters that could be
      // rendered downstream. The visual layer escapes too, but boundary
      // validation is the defense in depth.
      if (name && !/^[\p{L}\p{M}\d \-'.]+$/u.test(name)) {
        throw new Error("Name contains characters that aren't allowed.");
      }
    }
    sets.push("name = ?");
    params.push(name && name.length > 0 ? name : null);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "pictureUrl")) {
    let url = patch.pictureUrl;
    if (typeof url === "string") {
      url = url.trim();
      if (url.length > URL_MAX_LEN) {
        throw new Error("Picture URL is too long.");
      }
      if (url && !URL_HTTP_RE.test(url)) {
        throw new Error("Picture URL must start with http:// or https://.");
      }
    }
    sets.push("picture_url = ?");
    params.push(url && url.length > 0 ? url : null);
  }

  if (sets.length === 0) return existing;

  params.push(userId);
  await run(
    `UPDATE users SET ${sets.join(", ")} WHERE id = ?`,
    params,
  );

  const updated = await getUserById(userId);
  if (!updated) throw new Error("user vanished after profile update");
  console.info("[auth users profile updated]", {
    user_id_hash: hashForLog(userId),
    fields: sets.map((s) => s.split(" ")[0]),
  });
  return updated;
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

/* ----------------------------- email + password ----------------------------- */
//
// "Old fashion" sign-up: anyone can create an account with email + password.
// No verification at this stage — that's deferred to a Phase 6 follow-up.
// The squatter risk is handled by the cross-provider link refusal in
// upsertUserOnSignIn above (an OAuth sign-in for the same email gets
// rejected with a clear "sign in with password instead" message).
//
// Password rules: 8-128 chars. No complexity rules — NIST modern guidance
// is that length beats character classes, and complexity rules push users
// toward predictable substitutions ("Password1!" satisfies most "complex"
// requirements). We just cap the length so a 10 MB password POST can't
// burn a Vercel function.

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

export class PublicAuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "email_invalid"
      | "password_too_short"
      | "password_too_long"
      | "email_taken"
      | "bad_credentials",
  ) {
    super(message);
    this.name = "PublicAuthError";
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (!normalized || !EMAIL_RE.test(normalized)) {
    throw new PublicAuthError(
      "Enter a valid email address.",
      "email_invalid",
    );
  }
  return normalized;
}

function assertPassword(password: string): void {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) {
    throw new PublicAuthError(
      `Password must be at least ${PASSWORD_MIN} characters.`,
      "password_too_short",
    );
  }
  if (password.length > PASSWORD_MAX) {
    throw new PublicAuthError(
      "Password is too long.",
      "password_too_long",
    );
  }
}

export interface PasswordSignupInput {
  email: string;
  password: string;
  /** Optional. If the email is already in use as an OAuth/magic-link
   *  identity, signup is REFUSED — the user should sign in with that
   *  provider instead, then add a password from Account & preferences
   *  (Phase 6+). */
  anonymousId: string | null;
}

/** Create a new email+password user. Throws PublicAuthError on shape /
 *  conflict failures; the route handler maps `code` to a friendly
 *  message. Same error message for "email already taken" regardless of
 *  underlying provider so we don't leak which providers the email is
 *  registered against. */
export async function createPasswordUser(
  input: PasswordSignupInput,
): Promise<UserRow> {
  const email = assertEmail(input.email);
  assertPassword(input.password);

  const existing = await getUserByEmail(email);
  if (existing) {
    throw new PublicAuthError(
      "An account with this email already exists.",
      "email_taken",
    );
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(input.password);
  await run(
    `INSERT INTO users
        (id, email, role, password_hash, name, picture_url,
         provider, provider_sub, anonymous_id, last_seen_at, created_at)
      VALUES (?, ?, 'user', ?, NULL, NULL, 'email', ?, ?, ?, ?)`,
    [id, email, passwordHash, email, input.anonymousId, now, now],
  );
  const created = await getUserById(id);
  if (!created) throw new Error("user vanished after password insert");
  console.info("[auth users password-created]", {
    user_id_hash: hashForLog(id),
    anon_present: input.anonymousId !== null,
  });
  return created;
}

/** Verify an email + password pair and return the user on success.
 *  Throws PublicAuthError(code='bad_credentials') for any failure —
 *  unknown email, wrong password, wrong provider type — so the
 *  caller's response shape never leaks which one. */
export async function verifyPasswordLogin(
  email: string,
  password: string,
): Promise<UserRow> {
  const normalized = assertEmail(email);
  // Don't run assertPassword here — a too-short submitted password is
  // a bad-credentials response, not a "your password is too short"
  // lecture. Reveals information about the stored value otherwise.

  const row = await getUserByEmail(normalized);
  // Constant-ish timing: still run a dummy verifyPassword when the row
  // is missing so the response time doesn't reveal user existence.
  const stored = row?.password_hash ?? "scrypt$00$00";
  const ok = await verifyPassword(password, stored);
  if (!row || row.role !== "user" || !row.password_hash || !ok) {
    throw new PublicAuthError(
      "Email or password is incorrect.",
      "bad_credentials",
    );
  }
  await touchLastSeen(row.id);
  return row;
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
