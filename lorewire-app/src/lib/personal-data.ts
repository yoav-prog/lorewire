// Registry of where a public user's data lives, for self-serve data EXPORT
// (GDPR Article 15 access / Article 20 portability).
//
// Account DELETION is owned by lib/account-deletion.ts (deleteUserCompletely),
// the single canonical erasure path shared by the self-serve control and the
// Meta data-deletion callback. This module deliberately does NOT delete
// anything — it only reads — so the two concerns can't drift into deleting and
// exporting different sets of rows. The drift-guard test keeps export coverage
// honest: it fails the build if a schema table grows a `user_id` column that
// isn't exported here.
//
// Plan: _plans/2026-06-22-gdpr-compliance.md §Phase 2 (export).

import "server-only";
import { all } from "@/lib/db";
import type { UserRow } from "@/lib/users";

export interface ExportSource {
  /** Table name in src/lib/schema.ts. */
  table: string;
  /** Column locating this user's rows: "id" for the users row itself,
   *  "user_id" for the per-user satellite tables, or a comment table's own FK
   *  name (author_user_id for authored comments, reporter_user_id for reports). */
  column: "id" | "user_id" | "author_user_id" | "reporter_user_id";
  /** Plain-language label for the export summary UI. */
  description: string;
  /** Columns to include. Omit secrets (the password hash) and internal
   *  nonces (the anti-double-vote token, the rate-limit hash). When unset,
   *  the whole row is exported. */
  columns?: string[];
}

// Every place a public user's own data lives that belongs in an export. Keyed
// by the user's id throughout (the users row by `id`, satellites by
// `user_id`). magic_link_tokens is intentionally absent: those are short-lived
// one-time sign-in tokens (security material, pruned on a 15-minute expiry),
// not portable user content.
export const EXPORT_SOURCES: ExportSource[] = [
  {
    table: "users",
    column: "id",
    description: "Account profile",
    // Never export the password hash.
    columns: [
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
  { table: "user_saves", column: "user_id", description: "Saved stories" },
  { table: "user_likes", column: "user_id", description: "Liked stories" },
  {
    table: "user_fav_categories",
    column: "user_id",
    description: "Favorite categories",
  },
  {
    table: "user_recently_viewed",
    column: "user_id",
    description: "Recently viewed",
  },
  {
    table: "user_continue",
    column: "user_id",
    description: "Reading and watching progress",
  },
  {
    table: "poll_votes",
    column: "user_id",
    description: "Poll votes",
    // Drop the internal anti-double-vote nonce and the rate-limit hash; export
    // only the meaningful answer.
    columns: ["poll_id", "story_id", "article_id", "category", "side", "created_at"],
  },
  {
    table: "comments",
    column: "author_user_id",
    description: "Comments you posted",
    // The content and where it sits. Drop the anti-double-like cookie nonce,
    // the rate-limit fingerprint, and the internal AI moderation/editorial
    // signals (those are processing metadata, not the user's own content).
    columns: [
      "id",
      "article_id",
      "parent_id",
      "body",
      "lang",
      "status",
      "edited_at",
      "created_at",
    ],
  },
  {
    table: "comment_likes",
    column: "user_id",
    description: "Comment likes",
    // Drop the anonymous cookie nonce; the like is just which comment.
    columns: ["comment_id", "created_at"],
  },
  {
    table: "comment_reports",
    column: "reporter_user_id",
    description: "Comments you reported",
    columns: ["comment_id", "reason", "status", "created_at"],
  },
];

export interface DataExport {
  exportedAt: string;
  userId: string;
  /** One key per source; value is that source's rows for this user. */
  data: Record<string, unknown[]>;
}

/** Read everything we hold about a user, for an Article 15 / 20 request.
 *  Read-only. The caller (the export route) verifies the request is the
 *  user's own (session-scoped); the user id is never taken from the request. */
export async function exportUserData(user: UserRow): Promise<DataExport> {
  const data: Record<string, unknown[]> = {};
  for (const source of EXPORT_SOURCES) {
    const cols = source.columns ? source.columns.join(", ") : "*";
    data[source.table] = await all(
      `SELECT ${cols} FROM ${source.table} WHERE ${source.column} = ?`,
      [user.id],
    );
  }
  return { exportedAt: new Date().toISOString(), userId: user.id, data };
}

/** The export registry as plain rows, for the ROPA generated in Phase 5. */
export function describeExportSources(): Array<{
  table: string;
  description: string;
}> {
  return EXPORT_SOURCES.map((s) => ({
    table: s.table,
    description: s.description,
  }));
}
