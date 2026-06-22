// Account deletion — the single, shared way a public user's data leaves
// LoreWire. Two callers today:
//   1. The Meta data-deletion callback (a Facebook user removed the app or
//      asked Facebook to delete their data).
//   2. The self-serve "Delete my account" control in the account page.
// Both funnel through deleteUserCompletely so the two paths can never drift
// to delete different sets of rows.
//
// There are NO foreign keys in this schema (see lib/schema.ts), so deletion
// has to enumerate every table that carries a user_id by hand. USER_DATA_TABLES
// is that enumeration kept in ONE place: when a future feature adds a
// per-user table, adding it to this list is the only edit needed for deletion
// to stay complete. A table left off this list is data that silently survives
// a deletion request — a privacy bug — so the list lives next to the function
// that consumes it, not scattered across call sites.
//
// Plan: _plans/2026-06-22-facebook-login-and-data-deletion.md §B.

import "server-only";

import { one, run } from "@/lib/db";
import { hashForLog } from "@/lib/users";

/** Every table keyed by `user_id` whose rows are personal data and should be
 *  removed outright on deletion. poll_votes is deliberately NOT here — its
 *  rows feed an anonymous aggregate tally that's legitimate retained data, so
 *  it gets re-anonymized (below) rather than deleted. */
export const USER_DATA_TABLES = [
  "user_saves",
  "user_likes",
  "user_fav_categories",
  "user_recently_viewed",
  "user_continue",
] as const;

export interface DeleteResult {
  /** True when a `users` row existed for this id and was removed. False when
   *  the id resolved to no account (already deleted / never existed) — the
   *  satellite wipes still run and are harmless no-ops. */
  deletedUser: boolean;
}

/** Wipe a public user and everything tied to them. Idempotent: a second call
 *  for the same id is a clean no-op. Crash-safe without a transaction (this
 *  codebase uses none): satellites and poll-vote anonymization run first and
 *  the `users` row is deleted LAST, so a failure partway through leaves the
 *  account row intact and still findable by (provider, provider_sub) — the
 *  Meta callback's retry, or a re-click, then completes the job. */
export async function deleteUserCompletely(
  userId: string,
): Promise<DeleteResult> {
  if (!userId) throw new Error("deleteUserCompletely: userId required");

  const existed =
    (await one<{ id: string }>("SELECT id FROM users WHERE id = ?", [
      userId,
    ])) !== null;

  // 1. Satellite per-user state tables.
  for (const table of USER_DATA_TABLES) {
    await run(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
  }

  // 2. Re-anonymize this user's poll votes. The vote still counts toward the
  //    poll's anonymous aggregate, but every identifier that could tie it
  //    back to a person is nulled: user_id (the account link), cookie_token
  //    (the browser anti-double-vote nonce), and ip_ua_hash (the rate-limit
  //    fingerprint, already nulled after 24h by the retention cron but cleared
  //    here too so deletion doesn't depend on that timing).
  await run(
    `UPDATE poll_votes
        SET user_id = NULL, cookie_token = NULL, ip_ua_hash = NULL
      WHERE user_id = ?`,
    [userId],
  );

  // 3. The identity row LAST (see crash-safety note above).
  await run("DELETE FROM users WHERE id = ?", [userId]);

  console.info("[account-deletion wiped]", {
    user_id_hash: hashForLog(userId),
    existed,
  });
  return { deletedUser: existed };
}

export type DeletionSource = "facebook" | "self_serve";

export interface DeletionRequestRecord {
  confirmation_code: string;
  source: string;
  subject_hash: string;
  deleted: number;
  created_at: string;
}

/** Persist an audit row for a honored deletion request, keyed by the
 *  confirmation_code we return to the requester. INSERT-or-ignore so a Meta
 *  retry (same code) doesn't double-log or error. `subject` is the raw
 *  Facebook app-scoped id or internal user id; it is hashed before storage so
 *  no reversible identifier lands in the log (rule 13). */
export async function recordDeletionRequest(input: {
  confirmationCode: string;
  source: DeletionSource;
  subject: string;
  deleted: boolean;
}): Promise<void> {
  await run(
    `INSERT INTO data_deletion_requests
        (confirmation_code, source, subject_hash, deleted, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(confirmation_code) DO NOTHING`,
    [
      input.confirmationCode,
      input.source,
      hashForLog(input.subject),
      input.deleted ? 1 : 0,
      new Date().toISOString(),
    ],
  );
}

/** Look up a deletion audit row by its confirmation code. Drives the public
 *  /data-deletion/[code] status page. */
export async function getDeletionRequest(
  confirmationCode: string,
): Promise<DeletionRequestRecord | null> {
  if (!confirmationCode) return null;
  return (
    (await one<DeletionRequestRecord>(
      "SELECT * FROM data_deletion_requests WHERE confirmation_code = ?",
      [confirmationCode],
    )) ?? null
  );
}
