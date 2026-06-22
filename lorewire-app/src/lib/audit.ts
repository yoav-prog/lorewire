// Admin audit log — the spine of the user-management feature. Every sensitive
// admin action (role change, suspend, delete, invite, impersonate) writes one
// row through audit(): who did what, to whom, when.
//
// PII-free by construction. Actor and target are stored as an opaque id plus a
// one-way HASHED label (hashForLog / SHA-256, 8 hex chars). The `metadata` JSON
// is the caller's responsibility to keep PII-free. A row references nothing by
// foreign key (there are none here) and survives the GDPR deletion of its
// target with zero dangling PII — the only trace left is the hash, which is not
// reversible. Display names are resolved live from the ids at read time (the
// UI layer joins against the current users), so a deleted user simply shows as
// its hash, never a retained email.
//
// Append-only. There is intentionally no update or delete helper — the table
// only grows, and that is the tamper-resistance at this scale.
//
// Storage: src/lib/schema.ts ADMIN_AUDIT_LOG + its indexes in POST_TABLE_DDL.
// Plan: _plans/2026-06-22-admin-user-management.md (Phase 1).

import "server-only";
import { randomUUID } from "node:crypto";

import { all, one, run } from "@/lib/db";
import { hashForLog } from "@/lib/users";

// The closed set of audited actions. Adding a value here is the deliberate act
// of declaring a new audited action; keeping it closed means every emitted
// action is greppable and the audit vocabulary stays canonical. Dotted
// `<domain>.<verb>` keys so the by-action filter and a future "all team.*"
// view read cleanly.
export type AuditAction =
  | "user.suspend"
  | "user.unsuspend"
  | "user.delete"
  | "user.role_change"
  | "user.impersonate_start"
  | "user.impersonate_stop"
  | "team.invite_create"
  | "team.invite_revoke"
  | "team.invite_accept"
  | "team.member_remove";

// The kind of thing an action targets. Generic on purpose so any future entity
// becomes auditable without a schema change.
export type AuditTargetType = "user" | "invite";

export interface AuditInput {
  /** users.id of the staff member who performed the action. */
  actorId: string;
  /** Actor's email; stored only as a hash (actor_label). Omit if unknown. */
  actorEmail?: string | null;
  action: AuditAction;
  targetType: AuditTargetType;
  /** id of the affected entity (e.g. the user being suspended). */
  targetId: string;
  /** Target's email/handle; stored only as a hash (target_label). */
  targetEmail?: string | null;
  /** Extra context — MUST be PII-free (e.g. { from: 'user', to: 'moderator' }). */
  metadata?: Record<string, unknown> | null;
  /** Request IP; stored only as a hash (ip_hash). Best-effort. */
  ip?: string | null;
}

export interface AuditLogRow {
  id: string;
  actor_id: string | null;
  actor_label: string | null;
  action: string | null;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  metadata: string | null;
  ip_hash: string | null;
  created_at: string | null;
}

const AUDIT_COLS =
  "id, actor_id, actor_label, action, target_type, target_id, " +
  "target_label, metadata, ip_hash, created_at";

// Write one audit row. Throws if the insert fails: the audit log is the spine,
// so a caller performing a sensitive action should treat an audit-write failure
// as a failure of the action (fail closed) rather than silently proceeding
// unlogged. Callers decide ordering relative to their mutation.
export async function audit(input: AuditInput): Promise<void> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  try {
    await run(
      `INSERT INTO admin_audit_log
         (${AUDIT_COLS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.actorId,
        input.actorEmail ? hashForLog(input.actorEmail) : null,
        input.action,
        input.targetType,
        input.targetId,
        input.targetEmail ? hashForLog(input.targetEmail) : null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.ip ? hashForLog(input.ip) : null,
        createdAt,
      ],
    );
  } catch (err) {
    // Loud, PII-free failure line — never swallow a missing audit record.
    console.error("[audit] write failed", {
      action: input.action,
      actorId: input.actorId,
      targetType: input.targetType,
      targetId: input.targetId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  // rule 14: observability from day one — ids + action only, never PII.
  console.info("[audit]", {
    action: input.action,
    actorId: input.actorId,
    targetType: input.targetType,
    targetId: input.targetId,
  });
}

export interface AuditQuery {
  /** Exact actor id. */
  actorId?: string;
  /** Exact action key. */
  action?: string;
  /** Exact target kind. */
  targetType?: string;
  /** Exact target id (pairs with targetType for a single entity's trail). */
  targetId?: string;
  /** Free-text search across action, hashed labels, target id, and metadata. */
  q?: string;
  /** Page size. Default 50, clamped to [1, 500]. */
  limit?: number;
  /** Rows to skip (offset pagination). Default 0. */
  offset?: number;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 50;
  return Math.min(Math.max(Math.trunc(limit), 1), 500);
}

// Split a free-text query into at most 8 lowercased tokens. Each token must
// land in at least one searchable column (AND across tokens, OR within a
// token) — same contract as listStoriesForSearch in repo.ts.
function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
}

// Shared WHERE builder so list and count filter identically.
function buildWhere(query: AuditQuery): { clause: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.actorId) {
    where.push("actor_id = ?");
    params.push(query.actorId);
  }
  if (query.action) {
    where.push("action = ?");
    params.push(query.action);
  }
  if (query.targetType) {
    where.push("target_type = ?");
    params.push(query.targetType);
  }
  if (query.targetId) {
    where.push("target_id = ?");
    params.push(query.targetId);
  }
  if (query.q && query.q.trim()) {
    for (const token of tokenize(query.q)) {
      where.push(
        "(LOWER(COALESCE(action, '')) LIKE ? " +
          "OR LOWER(COALESCE(actor_label, '')) LIKE ? " +
          "OR LOWER(COALESCE(target_label, '')) LIKE ? " +
          "OR LOWER(COALESCE(target_id, '')) LIKE ? " +
          "OR LOWER(COALESCE(metadata, '')) LIKE ?)",
      );
      const like = `%${token}%`;
      params.push(like, like, like, like, like);
    }
  }
  return {
    clause: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

// Newest-first page of audit rows matching the filters. Display labels are NOT
// resolved here — callers join target_id/actor_id against current users for a
// human-readable name (a deleted target keeps only its hash).
export async function listAuditLog(
  query: AuditQuery = {},
): Promise<AuditLogRow[]> {
  const { clause, params } = buildWhere(query);
  const limit = clampLimit(query.limit);
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  return all<AuditLogRow>(
    `SELECT ${AUDIT_COLS} FROM admin_audit_log ${clause} ` +
      `ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
}

// Total rows matching the filters — for the pagination control.
export async function countAuditLog(query: AuditQuery = {}): Promise<number> {
  const { clause, params } = buildWhere(query);
  const row = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM admin_audit_log ${clause}`,
    params,
  );
  return Number(row?.n ?? 0);
}

// Convenience: the audit trail for a single entity (the per-user detail panel).
export async function listAuditForTarget(
  targetType: AuditTargetType,
  targetId: string,
  limit = 50,
): Promise<AuditLogRow[]> {
  return listAuditLog({ targetType, targetId, limit });
}

// Parse a row's metadata JSON safely — returns {} for null or malformed data
// so the UI never throws on a hand-written or legacy row.
export function parseAuditMetadata(row: AuditLogRow): Record<string, unknown> {
  if (!row.metadata) return {};
  try {
    const parsed = JSON.parse(row.metadata) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
