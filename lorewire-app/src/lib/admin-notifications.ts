// Admin notifications inbox — the persistent "something needs a human"
// feed behind /admin/notifications and the sidebar unread badge.
//
// Writers are server-side subsystems that hit a terminal failure the
// operator must see (today: the two auto-publish drains when a story
// could NOT go live). Reads are the notifications page + the badge
// count. Rows are append-only; the operator's only write is marking
// them read.
//
// Dedupe contract: a writer that fires repeatedly for the same stuck
// subject (cron ticks) passes one stable `dedupeKey`. While an UNREAD
// row with that key exists, further writes are dropped — the inbox
// shows one actionable row per problem, not one per tick. Once the
// operator marks it read, a fresh occurrence creates a fresh row
// (recurrence is information, not noise).
//
// notifyAdmin never throws: a notification write failing must not take
// down the cron that was trying to report a DIFFERENT failure. It
// returns what happened so callers can log it if they care.
//
// Plan: _plans/2026-07-02-never-publish-without-video.md.

import "server-only";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";

export type AdminNotificationSeverity = "error" | "warning";

export interface AdminNotificationRow {
  id: string;
  created_at: string;
  severity: AdminNotificationSeverity;
  source: string;
  subject_kind: string | null;
  subject_id: string | null;
  title: string;
  /** JSON blob of writer-specific context; null when the writer had none. */
  detail: string | null;
  dedupe_key: string | null;
  read_at: string | null;
}

export interface NotifyAdminInput {
  severity: AdminNotificationSeverity;
  /** Subsystem name, e.g. 'auto-publish' | 'full-pipeline'. Shown as a
   *  chip on the notifications page and greppable in logs. */
  source: string;
  subjectKind?: "story";
  subjectId?: string | null;
  title: string;
  /** Structured context — serialised to JSON for the detail column. */
  detail?: Record<string, unknown>;
  /** Stable key for the dedupe contract above. Omit to always insert. */
  dedupeKey?: string;
}

export type NotifyAdminResult =
  | { created: true; id: string }
  | { created: false; reason: "deduped" | "write_failed" };

/** Write a notification row (or drop it as a dupe). Never throws. */
export async function notifyAdmin(
  input: NotifyAdminInput,
): Promise<NotifyAdminResult> {
  try {
    if (input.dedupeKey) {
      const existing = await one<{ id: string }>(
        "SELECT id FROM admin_notifications WHERE dedupe_key = ? AND read_at IS NULL LIMIT 1",
        [input.dedupeKey],
      );
      if (existing) {
        console.info("[admin notify] deduped", {
          dedupe_key: input.dedupeKey,
          existing_id: existing.id,
        });
        return { created: false, reason: "deduped" };
      }
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    await run(
      `INSERT INTO admin_notifications
         (id, created_at, severity, source, subject_kind, subject_id,
          title, detail, dedupe_key, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        id,
        now,
        input.severity,
        input.source,
        input.subjectKind ?? null,
        input.subjectId ?? null,
        input.title,
        input.detail ? JSON.stringify(input.detail) : null,
        input.dedupeKey ?? null,
      ],
    );
    console.info("[admin notify] created", {
      id,
      severity: input.severity,
      source: input.source,
      subject_id: input.subjectId ?? null,
      title: input.title,
    });
    return { created: true, id };
  } catch (e) {
    console.error("[admin notify] write failed", {
      source: input.source,
      title: input.title,
      message: e instanceof Error ? e.message : String(e),
    });
    return { created: false, reason: "write_failed" };
  }
}

/** Unread count for the sidebar badge. */
export async function countUnreadAdminNotifications(): Promise<number> {
  const rows = await all<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM admin_notifications WHERE read_at IS NULL",
    [],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Inbox read: unread first, newest first within each group. The page
 *  shows read rows too (an audit trail of what went wrong lately), so
 *  the operator can scroll history without a separate view. */
export async function listAdminNotifications(
  limit = 100,
): Promise<AdminNotificationRow[]> {
  return all<AdminNotificationRow>(
    `SELECT id, created_at, severity, source, subject_kind, subject_id,
            title, detail, dedupe_key, read_at
     FROM admin_notifications
     ORDER BY (read_at IS NULL) DESC, created_at DESC
     LIMIT ?`,
    [limit],
  );
}

export async function markAdminNotificationRead(id: string): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "UPDATE admin_notifications SET read_at = ? WHERE id = ? AND read_at IS NULL",
    [now, id],
  );
  console.info("[admin notify] marked read", { id });
}

export async function markAllAdminNotificationsRead(): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "UPDATE admin_notifications SET read_at = ? WHERE read_at IS NULL",
    [now],
  );
  console.info("[admin notify] marked all read", {});
}
