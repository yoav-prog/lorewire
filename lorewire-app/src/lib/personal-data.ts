// The single registry of every place LoreWire stores personal data about a
// public user, and what to do with each on a data-subject request (GDPR
// Articles 15 access, 17 erasure, 20 portability).
//
// Why this exists as ONE table-driven list rather than ad-hoc SQL in the
// delete/export routes: the schema has no foreign keys, so a hand-written
// multi-table sweep silently goes stale the moment someone adds a new
// per-user table. The drift guard in personal-data.test.ts fails the build
// when a schema table grows a `user_id` column that isn't registered here, so
// erasure and export can never quietly miss data. This list is also the
// engineering half of the Records of Processing Activities (ROPA) — see
// describeSources().
//
// Scope: the PUBLIC reader/account holder (users.role = 'user'). Staff-only
// columns (articles.author_id, *_renders.requested_by) describe a different
// data subject (the operator's own staff) and are deliberately out of scope;
// they are not keyed on `user_id` so the drift guard does not flag them.
//
// Plan: _plans/2026-06-22-gdpr-compliance.md §Phase 1.

import "server-only";
import { all, run } from "@/lib/db";
import { normalizeEmail, type UserRow } from "@/lib/users";

/** How a source is cleared on erasure.
 *  - delete-rows:    DELETE rows located by `column` = the user's id.
 *  - delete-subject: DELETE the user's own row in `users` (run LAST).
 *  - delete-by-email: DELETE rows located by `column` = the user's email
 *      (used by transient tables keyed on email, not user id).
 *  - de-identify:    NULL out `column` instead of deleting, so aggregate
 *      counts survive while the row stops pointing at a person. */
export type ErasureStrategy =
  | "delete-rows"
  | "delete-subject"
  | "delete-by-email"
  | "de-identify";

export interface PersonalDataSource {
  /** Table name in src/lib/schema.ts. */
  table: string;
  /** Column used to locate this subject's data. */
  column: string;
  /** Plain-language purpose. Feeds the export summary and the ROPA. */
  description: string;
  strategy: ErasureStrategy;
  /** Whether this source is included in a data export. Security material
   *  (one-time sign-in tokens) is erased but never exported. */
  exportable: boolean;
  /** When set, export only these columns (drops secrets / internal nonces).
   *  When omitted, the whole row is exported. */
  exportColumns?: string[];
}

// Order is informational; deletion order is derived in eraseUserData (the
// subject row is always cleared last). The users row sits last here to mirror
// that.
export const PERSONAL_DATA_SOURCES: PersonalDataSource[] = [
  {
    table: "user_saves",
    column: "user_id",
    description: "Stories you saved to your list.",
    strategy: "delete-rows",
    exportable: true,
  },
  {
    table: "user_likes",
    column: "user_id",
    description: "Stories you liked.",
    strategy: "delete-rows",
    exportable: true,
  },
  {
    table: "user_fav_categories",
    column: "user_id",
    description: "Categories you marked as favorites.",
    strategy: "delete-rows",
    exportable: true,
  },
  {
    table: "user_recently_viewed",
    column: "user_id",
    description: "Stories you recently viewed.",
    strategy: "delete-rows",
    exportable: true,
  },
  {
    table: "user_continue",
    column: "user_id",
    description: "Your reading and watching progress.",
    strategy: "delete-rows",
    exportable: true,
  },
  {
    table: "poll_votes",
    column: "user_id",
    description:
      "Your answers to engagement polls. On deletion these are de-identified (the link to your account is removed) rather than deleted, so aggregate results stay accurate.",
    strategy: "de-identify",
    exportable: true,
    // Drop the internal anti-double-vote nonce and the rate-limit hash; export
    // only the meaningful answer.
    exportColumns: [
      "poll_id",
      "story_id",
      "article_id",
      "category",
      "side",
      "created_at",
    ],
  },
  {
    table: "magic_link_tokens",
    column: "email",
    description:
      "One-time email sign-in links. Security material: erased on account deletion, never exported.",
    strategy: "delete-by-email",
    exportable: false,
  },
  {
    table: "users",
    column: "id",
    description: "Your account: email, display name, picture, sign-in method.",
    strategy: "delete-subject",
    exportable: true,
    // Never export the password hash.
    exportColumns: [
      "id",
      "email",
      "role",
      "name",
      "picture_url",
      "provider",
      "anonymous_id",
      "last_seen_at",
      "created_at",
    ],
  },
];

export interface DataExport {
  exportedAt: string;
  userId: string;
  /** One key per exportable source; value is the array of that source's rows
   *  for this user. */
  data: Record<string, unknown[]>;
}

/** Read everything we hold about a user, for an Article 15 / 20 request.
 *  Read-only. The caller (the export route) is responsible for verifying the
 *  request is the user's own (session-scoped, re-authenticated). */
export async function exportUserData(user: UserRow): Promise<DataExport> {
  const email = normalizeEmail(user.email);
  const data: Record<string, unknown[]> = {};

  for (const source of PERSONAL_DATA_SOURCES) {
    if (!source.exportable) continue;
    const cols = source.exportColumns ? source.exportColumns.join(", ") : "*";
    const locatorValue = source.column === "email" ? email : user.id;
    data[source.table] = await all(
      `SELECT ${cols} FROM ${source.table} WHERE ${source.column} = ?`,
      [locatorValue],
    );
  }

  return {
    exportedAt: new Date().toISOString(),
    userId: user.id,
    data,
  };
}

export interface ErasureResult {
  userId: string;
  erasedAt: string;
}

/** Erase a user across every registered source, then VERIFY nothing the
 *  registry knows about still points at them. Throws if any source still has
 *  the subject's data after the sweep, so the caller never reports a
 *  completed erasure it did not actually complete.
 *
 *  This follows the existing sequential-delete idiom (see deleteStory in
 *  repo.ts): the store has no foreign keys and exposes no cross-driver
 *  transaction primitive, so we order the writes (every other source first,
 *  the users row last), keep each step idempotent (a re-run is a safe no-op),
 *  and gate success on a post-sweep verification read. */
export async function eraseUserData(user: UserRow): Promise<ErasureResult> {
  const email = normalizeEmail(user.email);

  // Subject row last: if the sweep dies partway, the account still exists and
  // a retry completes the erasure rather than orphaning child rows.
  const ordered = [
    ...PERSONAL_DATA_SOURCES.filter((s) => s.strategy !== "delete-subject"),
    ...PERSONAL_DATA_SOURCES.filter((s) => s.strategy === "delete-subject"),
  ];

  for (const source of ordered) {
    const locatorValue = source.column === "email" ? email : user.id;
    if (source.strategy === "de-identify") {
      await run(
        `UPDATE ${source.table} SET ${source.column} = NULL WHERE ${source.column} = ?`,
        [locatorValue],
      );
    } else {
      await run(
        `DELETE FROM ${source.table} WHERE ${source.column} = ?`,
        [locatorValue],
      );
    }
  }

  await verifyErased(user, email);

  return { userId: user.id, erasedAt: new Date().toISOString() };
}

/** Confirm no registered source still holds the subject's data. Any leftover
 *  row is a failed erasure and must surface as an error, not a silent pass. */
async function verifyErased(user: UserRow, email: string): Promise<void> {
  for (const source of PERSONAL_DATA_SOURCES) {
    const locatorValue = source.column === "email" ? email : user.id;
    const leftover = await all(
      `SELECT 1 FROM ${source.table} WHERE ${source.column} = ? LIMIT 1`,
      [locatorValue],
    );
    if (leftover.length > 0) {
      throw new Error(
        `erasure incomplete: ${source.table} still has rows for the subject`,
      );
    }
  }
}

/** The registry rendered as ROPA rows (one processing record per source).
 *  Consumed by the paperwork generated in Phase 5. */
export function describeSources(): Array<{
  table: string;
  description: string;
  onErasure: ErasureStrategy;
  inExport: boolean;
}> {
  return PERSONAL_DATA_SOURCES.map((s) => ({
    table: s.table,
    description: s.description,
    onErasure: s.strategy,
    inExport: s.exportable,
  }));
}
