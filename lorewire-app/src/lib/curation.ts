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
import { all, one, run, tx } from "@/lib/db";

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
  const pinned = {
    continueRow: pick("rail.continue"),
    top10: pick("rail.top10"),
    entitled: pick("rail.entitled"),
    newRow: pick("rail.new"),
  };

  // Phase 6 auto-fill: pad each opted-in rail with newest published
  // stories. Build the skip set from EVERY rail's pinned ids so a story
  // already on Top 10 doesn't also appear on New just because the
  // catalog is short — keeps the home page visually distinct.
  const autofillEnabled = await readAutofillSettings();
  const wantsFill =
    (autofillEnabled.has("rail.top10") && pinned.top10.length < RAIL_TARGET_LENGTH) ||
    (autofillEnabled.has("rail.new") && pinned.newRow.length < RAIL_TARGET_LENGTH) ||
    (autofillEnabled.has("rail.entitled") &&
      pinned.entitled.length < RAIL_TARGET_LENGTH);
  let filled = pinned;
  if (wantsFill) {
    const allPinned = new Set<string>([
      ...pinned.top10,
      ...pinned.newRow,
      ...pinned.entitled,
      ...pinned.continueRow,
    ]);
    if (billboardList[0]) allPinned.add(billboardList[0]);
    const newest = await newestPublishedIds(
      RAIL_TARGET_LENGTH * AUTOFILLABLE_RAILS.length,
      allPinned,
    );
    // Each rail gets its own slice of `newest`, advancing the cursor so
    // two rails don't show the same auto-filled story.
    let cursor = 0;
    const sliceFor = (count: number): string[] => {
      const out = newest.slice(cursor, cursor + count);
      cursor += out.length;
      return out;
    };
    filled = {
      continueRow: pinned.continueRow, // not auto-fillable by design
      top10: autofillEnabled.has("rail.top10")
        ? appendAutofill(
            pinned.top10,
            sliceFor(RAIL_TARGET_LENGTH - pinned.top10.length),
            RAIL_TARGET_LENGTH,
          )
        : pinned.top10,
      newRow: autofillEnabled.has("rail.new")
        ? appendAutofill(
            pinned.newRow,
            sliceFor(RAIL_TARGET_LENGTH - pinned.newRow.length),
            RAIL_TARGET_LENGTH,
          )
        : pinned.newRow,
      entitled: autofillEnabled.has("rail.entitled")
        ? appendAutofill(
            pinned.entitled,
            sliceFor(RAIL_TARGET_LENGTH - pinned.entitled.length),
            RAIL_TARGET_LENGTH,
          )
        : pinned.entitled,
    };
  }

  const picks: HomePagePicks = {
    billboard: billboardList[0] ?? null,
    ...filled,
  };
  console.info("[curation home]", {
    billboard: picks.billboard,
    continue: picks.continueRow.length,
    top10: picks.top10.length,
    entitled: picks.entitled.length,
    new: picks.newRow.length,
    autofilled: wantsFill,
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
  // Single transaction so a concurrent reader never observes the empty
  // window between DELETE and INSERT. Matches the Python side
  // (`store.set_slot_stories` uses BEGIN/COMMIT for the same reason).
  return tx(async (t) => {
    await t.run("DELETE FROM curation_slots WHERE slot_kind = ?", [slotKind]);
    if (storyIds.length === 0) return 0;
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
    await t.run(
      `INSERT INTO curation_slots (${COLS}) VALUES ${placeholders}`,
      params,
    );
    return storyIds.length;
  });
}

// ─── scheduled-replace write (Phase 6) ──────────────────────────────────────
//
// `setSlotStories` is the bulk write used when the admin only cares about
// order. Phase 6 adds per-row scheduling — same atomic-replace shape, but
// each pick can carry its own publish_at / expires_at. Empty array clears
// the slot (matches setSlotStories).

export interface SlotPickInput {
  story_id: string;
  /** ISO timestamp. NULL = active immediately. */
  publish_at?: string | null;
  /** ISO timestamp. NULL = no expiry. */
  expires_at?: string | null;
}

export async function setSlotPicks(
  slotKind: string,
  picks: SlotPickInput[],
  opts: { notes?: string | null } = {},
): Promise<number> {
  if (!slotKind) {
    throw new Error("setSlotPicks requires slotKind");
  }
  const now = new Date().toISOString();
  // Same transactional contract as setSlotStories. Without this, a
  // home-page render hitting the DB between DELETE and INSERT sees an
  // empty slot — and when auto-fill is also off, the rail renders zero
  // posters until the next save.
  return tx(async (t) => {
    await t.run("DELETE FROM curation_slots WHERE slot_kind = ?", [slotKind]);
    if (picks.length === 0) return 0;
    const placeholders = picks.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(
      ", ",
    );
    const params: unknown[] = [];
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i];
      params.push(
        randomUUID(),
        slotKind,
        i,
        p.story_id,
        normalizeIso(p.publish_at ?? null),
        normalizeIso(p.expires_at ?? null),
        opts.notes ?? null,
        now,
        now,
      );
    }
    await t.run(
      `INSERT INTO curation_slots (${COLS}) VALUES ${placeholders}`,
      params,
    );
    return picks.length;
  });
}

// Accept any of: ISO string, `datetime-local` value ("2026-06-15T18:30"
// or "2026-06-15T18:30:45"), an admin-typed full ISO with timezone,
// empty string. Returns a canonical ISO-with-Z string or null on
// unparseable input. We do NOT try to validate calendar correctness —
// the SQL comparison is lexical and tolerates partial timestamps as
// long as they sort right.
//
// Bare dates ("2026-06-20") are REJECTED because their interpretation
// is ambiguous (UTC midnight vs local midnight) and admins who type
// only a date rarely mean midnight UTC. Surfacing null lets the action
// reject the input with a soft error instead of silently writing the
// wrong instant.
export function normalizeIso(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Bare date — refuse rather than guess a time.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  // `datetime-local` widgets emit "YYYY-MM-DDTHH:mm" with no seconds and
  // no zone; Firefox with step<60 adds ":ss" and optionally ".fff".
  // Treat all of these as UTC so the value compares cleanly with the
  // activeAt filter — admins picking "12:00" expect "12:00 UTC", which
  // matches the implicit contract everywhere else in the codebase.
  const dtLocalMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/
    .exec(s);
  if (dtLocalMatch) {
    const [, date, time] = dtLocalMatch;
    const hms = time.length === 5 ? `${time}:00` : time;
    const d = new Date(`${date}T${hms}Z`);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  // Full ISO with timezone — let Date parse it. Reject anything else.
  // Date.parse accepts a wider grammar than ISO 8601; we filter to the
  // shapes that carry an explicit zone so we never accept a bare local
  // time and silently shift it by the admin's tz offset.
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ─── auto-fill remainder (Phase 6) ──────────────────────────────────────────
//
// When a rail's pinned set is shorter than its target length, pad the
// rest with the newest published stories. The toggle is per-slot kind so
// the admin can pin everything for a curated rail and let auto-fill pad
// only the rails that aren't worth babysitting.
//
// Settings layer (rule 15 in CLAUDE.md):
//   - `curation.autofill.<slot_kind>`: "1" enables fill, "0" disables.
//     Default is "1" — most rails want a populated UI even when admin
//     hasn't curated.
//   - rail.continue is NOT auto-fillable (semantically about user
//     playback state, padding it with newest stories is misleading).
//
// Target length is fixed at 10 per rail today. If the admin pins MORE
// than the target, all pinned stories still ship — auto-fill only
// pads, never truncates.

/** Rails that support auto-fill. Excludes rail.continue. */
export const AUTOFILLABLE_RAILS = [
  "rail.top10",
  "rail.new",
  "rail.entitled",
] as const;

export type AutofillableRail = (typeof AUTOFILLABLE_RAILS)[number];

export function isAutofillableRail(s: string): s is AutofillableRail {
  return (AUTOFILLABLE_RAILS as readonly string[]).includes(s);
}

export const RAIL_TARGET_LENGTH = 10;

export function autofillSettingKey(slotKind: AutofillableRail): string {
  return `curation.autofill.${slotKind}`;
}

/** Read every autofill toggle in one query. Returns the slot kinds for
 *  which auto-fill is enabled. Missing settings default to enabled. */
export async function readAutofillSettings(): Promise<Set<AutofillableRail>> {
  const rows = await all<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key LIKE ?",
    ["curation.autofill.%"],
  );
  const explicit = new Map(rows.map((r) => [r.key, r.value]));
  const enabled = new Set<AutofillableRail>();
  for (const rail of AUTOFILLABLE_RAILS) {
    const v = explicit.get(autofillSettingKey(rail));
    // Default enabled: only "0"/"false"/"off" disables. Anything else
    // (including missing) leaves auto-fill on.
    if (v === undefined || (v !== "0" && v.toLowerCase() !== "false" && v.toLowerCase() !== "off")) {
      enabled.add(rail);
    }
  }
  return enabled;
}

/** Newest published stories across the catalog, excluding ids in `skip`.
 *  Used by the home-page resolver to pad rails when auto-fill is on. */
async function newestPublishedIds(
  limit: number,
  skip: Set<string>,
): Promise<string[]> {
  // Pull a slightly larger window than needed so we can drop the skips
  // and still hit the limit without a second query. 3× headroom is more
  // than enough at LoreWire's catalog size (low hundreds).
  const window = Math.max(limit * 3, limit + skip.size);
  const rows = await all<{ id: string }>(
    "SELECT id FROM stories WHERE status = 'published' " +
      "ORDER BY COALESCE(published_at, updated_at, created_at) DESC " +
      "LIMIT ?",
    [window],
  );
  const out: string[] = [];
  for (const r of rows) {
    if (skip.has(r.id)) continue;
    out.push(r.id);
    if (out.length >= limit) break;
  }
  return out;
}

/** Append newest-first auto-fill onto a rail's admin picks. Pure helper —
 *  exported for unit testing the dedup behaviour. */
export function appendAutofill(
  pinned: readonly string[],
  newest: readonly string[],
  target: number,
): string[] {
  const out = [...pinned];
  const seen = new Set(pinned);
  for (const id of newest) {
    if (out.length >= target) break;
    if (seen.has(id)) continue;
    out.push(id);
    seen.add(id);
  }
  return out;
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

// ─── cleanup (Phase 6) ──────────────────────────────────────────────────────
//
// Daily cron sweep that hard-deletes rows whose expires_at is older than
// a grace window. Reads only — the active-at filter on the read path
// already hides expired rows from users; this just keeps the table from
// growing without bound. The 7-day default means an accidental
// "expires_at last Tuesday" the admin sets via the date picker stays
// recoverable for a week (just re-pin to a future date).

export async function deleteExpiredSlotRows(
  now: Date = new Date(),
  graceDays: number = 7,
): Promise<number> {
  if (graceDays < 0) {
    throw new Error("graceDays must be non-negative");
  }
  const cutoff = new Date(
    now.getTime() - graceDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const candidates = await all<{ id: string }>(
    "SELECT id FROM curation_slots " +
      "WHERE expires_at IS NOT NULL AND expires_at < ?",
    [cutoff],
  );
  if (candidates.length === 0) return 0;
  await run(
    "DELETE FROM curation_slots " +
      "WHERE expires_at IS NOT NULL AND expires_at < ?",
    [cutoff],
  );
  console.info("[curation cleanup-expired]", {
    cutoff,
    removed: candidates.length,
  });
  return candidates.length;
}
