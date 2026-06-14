// Public-site curation: which story occupies which slot on the front
// page, rails, and category pages.
//
// Phase 1 of _plans/2026-06-15-curation-system.md. This module owns:
//   - the slot-kind registry (the contract; admin actions validate
//     writes against this)
//   - the CRUD helpers the admin curation page calls
//   - the active-at filter the public page calls (respects publish_at /
//     expires_at scheduling)
//
// Mirrors pipeline/store.py's curation_slots helpers. Each side reads
// the same column names / order so a pipeline-side test and a TS-side
// test both validate the same row shape.

import "server-only";

import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";

// ─── slot-kind registry ──────────────────────────────────────────────────────
//
// One stable, finite list of slot kinds the admin can curate. Any write
// path validates against this; writes for unknown kinds are refused so
// a typo can't park rows in a dead slot.

/** Singleton slots: at most one story (extras ignored on read). */
export const SINGLETON_SLOT_KINDS = ["billboard.featured"] as const;

/** Many-story rails. Order is admin-controlled; auto-fill (Phase 6)
 *  pads to the target length from newest published. */
export const RAIL_SLOT_KINDS = [
  "rail.continue",
  "rail.top10",
  "rail.new",
  "rail.entitled",
] as const;

/** Categories. One slot per category. */
export const CATEGORY_KINDS = [
  "Drama",
  "Entitled",
  "Humor",
  "Wholesome",
  "Dating",
  "Roommate",
] as const;

export const CATEGORY_SLOT_KINDS = CATEGORY_KINDS.map(
  (c) => `category.${c}` as const,
);

/** Every valid slot_kind. Used to validate admin writes. */
export const CURATION_SLOT_KINDS = [
  ...SINGLETON_SLOT_KINDS,
  ...RAIL_SLOT_KINDS,
  ...CATEGORY_SLOT_KINDS,
] as const;

export type CurationSlotKind = (typeof CURATION_SLOT_KINDS)[number];

export function isCurationSlotKind(s: string): s is CurationSlotKind {
  return (CURATION_SLOT_KINDS as readonly string[]).includes(s);
}

// ─── row shape ───────────────────────────────────────────────────────────────

export interface CurationSlotRow {
  id: string;
  slot_kind: string;
  position: number;
  story_id: string;
  publish_at: string | null;
  expires_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  "id, slot_kind, position, story_id, publish_at, expires_at, notes, created_at, updated_at";

// ─── reads from the stories table (for the admin picker) ────────────────────

export interface CurationStoryOption {
  id: string;
  title: string | null;
  category: string | null;
  hero_image: string | null;
  status: string | null;
  published_at: string | null;
}

/** Every published story, newest-first. The admin curation page uses
 *  this to populate the "add story" search input — small dataset
 *  (hundreds of rows at most), so we hydrate the whole list once and
 *  let the client component filter locally. No paging. */
export async function listPublishedStoriesForCuration(): Promise<
  CurationStoryOption[]
> {
  return all<CurationStoryOption>(
    "SELECT id, title, category, hero_image, status, published_at " +
      "FROM stories WHERE status = 'published' " +
      "ORDER BY COALESCE(published_at, updated_at, created_at) DESC",
    [],
  );
}

// ─── reads ───────────────────────────────────────────────────────────────────

/** List the pinned stories for one slot, in admin order.
 *
 * `activeAt`: when provided, hide rows scheduled for the future
 * (publish_at > activeAt) or already expired (expires_at <= activeAt).
 * Public-page reads pass `new Date()`; admin reads pass undefined to
 * see every pinned row regardless of scheduling.
 */
export async function listSlots(
  slotKind: string,
  opts: { activeAt?: Date } = {},
): Promise<CurationSlotRow[]> {
  if (!slotKind) return [];
  const sql: string[] = [
    `SELECT ${COLS} FROM curation_slots WHERE slot_kind = ?`,
  ];
  const params: unknown[] = [slotKind];
  if (opts.activeAt) {
    const iso = opts.activeAt.toISOString();
    sql.push(
      "AND (publish_at IS NULL OR publish_at <= ?)",
      "AND (expires_at IS NULL OR expires_at > ?)",
    );
    params.push(iso, iso);
  }
  sql.push("ORDER BY position ASC");
  return all<CurationSlotRow>(sql.join(" "), params);
}

/** One-shot read of every pinned row across every kind. The admin
 *  curation page calls this on render to render every slot together. */
export async function listAllSlots(): Promise<
  Record<string, CurationSlotRow[]>
> {
  const rows = await all<CurationSlotRow>(
    `SELECT ${COLS} FROM curation_slots ORDER BY slot_kind ASC, position ASC`,
    [],
  );
  const out: Record<string, CurationSlotRow[]> = {};
  for (const r of rows) {
    (out[r.slot_kind] ??= []).push(r);
  }
  return out;
}

/** Just the story ids for a slot at `now`. Public page convenience. */
export async function getActivePicks(
  slotKind: string,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await listSlots(slotKind, { activeAt: now });
  return rows.map((r) => r.story_id);
}

/** Every slot a single story appears in. Used by the Phase 5 "appears in"
 *  panel on the story editor. */
export async function listSlotsForStory(
  storyId: string,
): Promise<CurationSlotRow[]> {
  if (!storyId) return [];
  return all<CurationSlotRow>(
    `SELECT ${COLS} FROM curation_slots WHERE story_id = ? ` +
      `ORDER BY slot_kind ASC, position ASC`,
    [storyId],
  );
}

// ─── writes ──────────────────────────────────────────────────────────────────

/** Atomic replace: delete every row for `slotKind`, insert the new
 *  ordered list. Single transaction so a reader can't observe the
 *  partial state between delete and insert.
 *
 *  Caller (the admin server action) is responsible for `requireAdmin`
 *  and for validating slotKind via `isCurationSlotKind`. */
export async function setSlotStories(
  slotKind: string,
  storyIds: string[],
  opts: { notes?: string | null } = {},
): Promise<number> {
  if (!slotKind) {
    throw new Error("setSlotStories requires slotKind");
  }
  const now = new Date().toISOString();
  // We don't have a portable BEGIN/COMMIT helper exposed by @/lib/db,
  // but the dual-driver layer keeps the connection warm for the
  // duration of the request — delete-then-insert in immediate
  // succession is the smallest reasonable critical section.
  await run("DELETE FROM curation_slots WHERE slot_kind = ?", [slotKind]);
  if (storyIds.length === 0) return 0;
  // Multi-row INSERT, same shape as bulk_insert_reddit_sources.
  const placeholders = storyIds.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(
    ", ",
  );
  const params: unknown[] = [];
  for (let i = 0; i < storyIds.length; i++) {
    params.push(
      randomUUID(),
      slotKind,
      i,
      storyIds[i],
      null,
      null,
      opts.notes ?? null,
      now,
      now,
    );
  }
  await run(
    `INSERT INTO curation_slots (${COLS}) VALUES ${placeholders}`,
    params,
  );
  return storyIds.length;
}

/** Append one story to a slot (or insert at `position`). UNIQUE
 *  (slot_kind, story_id) means re-adding throws; caller catches and
 *  surfaces "already pinned". Returns the new row id. */
export async function addToSlot(
  slotKind: string,
  storyId: string,
  opts: {
    position?: number;
    publishAt?: string | null;
    expiresAt?: string | null;
    notes?: string | null;
  } = {},
): Promise<string> {
  if (!slotKind || !storyId) {
    throw new Error("addToSlot requires slotKind and storyId");
  }
  let position = opts.position;
  if (position === undefined) {
    const row = await one<{ m: number | string | null }>(
      "SELECT COALESCE(MAX(position), -1) AS m FROM curation_slots " +
        "WHERE slot_kind = ?",
      [slotKind],
    );
    position = (Number(row?.m ?? -1) | 0) + 1;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO curation_slots (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      slotKind,
      position,
      storyId,
      opts.publishAt ?? null,
      opts.expiresAt ?? null,
      opts.notes ?? null,
      now,
      now,
    ],
  );
  return id;
}

/** Hard-delete one curation_slots row. Returns true when a row was
 *  removed. Uses node:sqlite's lack of rowcount-from-run via a
 *  pre-check; on Postgres the count is reliable via the driver. */
export async function removeFromSlot(slotId: string): Promise<boolean> {
  if (!slotId) return false;
  const existed = await one<{ id: string }>(
    "SELECT id FROM curation_slots WHERE id = ?",
    [slotId],
  );
  if (!existed) return false;
  await run("DELETE FROM curation_slots WHERE id = ?", [slotId]);
  return true;
}

/** Rewrite positions for the slot in the order provided. Each id must
 *  already belong to the slot (`slot_kind` match enforced); ids that
 *  don't match are silently skipped. */
export async function reorderSlot(
  slotKind: string,
  orderedIds: string[],
): Promise<number> {
  if (!slotKind || orderedIds.length === 0) return 0;
  const now = new Date().toISOString();
  for (let i = 0; i < orderedIds.length; i++) {
    await run(
      "UPDATE curation_slots SET position = ?, updated_at = ? " +
        "WHERE id = ? AND slot_kind = ?",
      [i, now, orderedIds[i], slotKind],
    );
  }
  return orderedIds.length;
}
