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

// ─── category-page resolver (Phase 3) ───────────────────────────────────────
//
// Used by /c/[category]/page.tsx. Returns the pinned curated stories
// for the category in admin order, then auto-fills with the rest of
// the category's published stories ordered by published_at DESC. Same
// story IS NOT duplicated — auto-fill skips ids already pinned.

export interface CategoryStoryRow {
  id: string;
  title: string | null;
  category: string | null;
  hero_image: string | null;
  summary: string | null;
  published_at: string | null;
  /** Did this row come from curation_slots (admin-pinned) or the
   *  newest-first auto-fill? Lets the UI mark pinned rows visually
   *  if it wants to. */
  pinned: boolean;
}

export async function resolveCategoryPage(
  category: string,
  opts: { limit?: number; now?: Date } = {},
): Promise<CategoryStoryRow[]> {
  if (!category) return [];
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const slotKind = `category.${category}`;
  const pinnedIds = await getActivePicks(slotKind, opts.now ?? new Date());

  // Pull every published story in this category once; partition in
  // memory. At LoreWire's current scale (sub-200 published stories per
  // category) one SELECT plus an in-memory walk is cheaper than two
  // SELECTs + a NOT IN clause that breaks past 32k bind params.
  const allRows = await allPublishedInCategory(category);

  const byId = new Map<string, CategoryStoryRow>();
  for (const r of allRows) {
    byId.set(r.id, { ...r, pinned: false });
  }

  const out: CategoryStoryRow[] = [];
  const seen = new Set<string>();

  // 1. Pinned rows in admin order. Skip ids whose story is missing
  //    or unpublished — admin can pin a story before it ships (per
  //    the Phase 1 plan note about scheduling), but the public page
  //    only renders rows that are actually viewable.
  for (const id of pinnedIds) {
    const row = byId.get(id);
    if (!row) continue;
    out.push({ ...row, pinned: true });
    seen.add(id);
    if (out.length >= limit) return out;
  }

  // 2. Auto-fill remainder, newest-first. allPublishedInCategory
  //    already ORDERed BY published_at DESC.
  for (const r of allRows) {
    if (seen.has(r.id)) continue;
    out.push({ ...r, pinned: false });
    if (out.length >= limit) break;
  }

  return out;
}

async function allPublishedInCategory(
  category: string,
): Promise<CategoryStoryRow[]> {
  return all<CategoryStoryRow>(
    "SELECT id, title, category, hero_image, summary, published_at, " +
      "0 AS pinned " +
      "FROM stories WHERE status = 'published' AND category = ? " +
      "ORDER BY COALESCE(published_at, updated_at, created_at) DESC",
    [category],
  );
}

// ─── home-page resolver (Phase 4) ───────────────────────────────────────────
//
// Used by `src/app/page.tsx` (server component) to pre-resolve every slot
// the home page renders. Returns story-id lists per slot so the client
// shell can swap in admin picks where present and fall back to the
// hardcoded arrays in `lib/stories.ts` where a slot is empty.
//
// One network round-trip — listAllSlots() returns every pinned row in
// one query — then we partition in-memory. Cheaper than five
// independent SELECTs and keeps the home page's TTFB tight.

export interface HomePagePicks {
  /** billboard.featured — singleton; null when admin hasn't picked. */
  billboard: string | null;
  /** rail.continue — admin order; empty array means "use fallback". */
  continueRow: string[];
  /** rail.top10 — admin order. */
  top10: string[];
  /** rail.entitled — admin order. */
  entitled: string[];
  /** rail.new — admin order. */
  newRow: string[];
}

export async function getHomePagePicks(
  now: Date = new Date(),
): Promise<HomePagePicks> {
  const grouped = await listAllSlots();
  const iso = now.toISOString();
  const isActive = (r: CurationSlotRow): boolean =>
    (r.publish_at === null || r.publish_at <= iso) &&
    (r.expires_at === null || r.expires_at > iso);
  const pick = (kind: string): string[] =>
    (grouped[kind] ?? [])
      .filter(isActive)
      .sort((a, b) => a.position - b.position)
      .map((r) => r.story_id);

  const billboardList = pick("billboard.featured");
  const picks: HomePagePicks = {
    billboard: billboardList[0] ?? null,
    continueRow: pick("rail.continue"),
    top10: pick("rail.top10"),
    entitled: pick("rail.entitled"),
    newRow: pick("rail.new"),
  };
  console.info("[curation home]", {
    billboard: picks.billboard,
    continue: picks.continueRow.length,
    top10: picks.top10.length,
    entitled: picks.entitled.length,
    new: picks.newRow.length,
  });
  return picks;
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
