// Storage helpers for `homepage_curation`. Wraps the position math (append,
// remove + densify, swap with neighbour) so callers never have to think
// about gaps or transactions. Surface enum is enforced HERE — every public
// helper rejects unknown surface names so a typo can't quietly create a
// rail that the homepage doesn't render.
//
// Plan: _plans/2026-06-16-homepage-curation.md (phase 1).

import "server-only";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";
import {
  HOMEPAGE_SURFACES,
  isHomepageSurface,
  SURFACE_CAPACITY,
  type HomepageSurface,
} from "@/lib/homepage-curation-shared";

// Re-export so historical call sites (TS + tests) can keep importing
// surface metadata from here without caring about the split. The split
// lives in -shared because client components can't transitively
// import server-only modules without Turbopack pulling node-only deps
// (postgres, node:crypto) into the browser bundle.
export {
  HOMEPAGE_SURFACES,
  SURFACE_CAPACITY,
  type HomepageSurface,
};

export interface CurationRow {
  id: string;
  surface: HomepageSurface;
  position: number;
  story_id: string;
  created_at: string;
  updated_at: string;
}

// Raw read for one surface, in position order. Stale-ref filtering lives
// at the public action layer — this helper just returns what the table
// says so the admin page can show "(unpublished — remove?)" chips.
export async function listSurface(
  surface: HomepageSurface,
): Promise<CurationRow[]> {
  return all<CurationRow>(
    "SELECT id, surface, position, story_id, created_at, updated_at " +
      "FROM homepage_curation WHERE surface = ? ORDER BY position ASC",
    [surface],
  );
}

// Read every surface in one trip — admin page server render uses this so
// the page loads with one query, not eleven.
export async function listAllCuration(): Promise<
  Record<HomepageSurface, CurationRow[]>
> {
  const rows = await all<CurationRow>(
    "SELECT id, surface, position, story_id, created_at, updated_at " +
      "FROM homepage_curation ORDER BY surface ASC, position ASC",
  );
  const out: Record<HomepageSurface, CurationRow[]> = {
    hero: [],
    top10: [],
    continue: [],
    new_row: [],
    entitled_row: [],
    humor_row: [],
    wholesome_row: [],
    dating_row: [],
    roommate_row: [],
    drama_row: [],
  };
  for (const r of rows) {
    if (isHomepageSurface(r.surface)) {
      out[r.surface].push(r);
    }
    // Unknown surfaces silently dropped — could happen if we shrink the
    // enum and leave orphan rows behind. The admin page would have no
    // place to render them anyway.
  }
  return out;
}

export type CurationResult =
  | { ok: true; row: CurationRow }
  | { ok: false; error: string };

// Append a story to the end of a surface. Refuses when:
//   - the surface name isn't in HOMEPAGE_SURFACES
//   - the surface has a fixed capacity that's already full
//   - the same story is already in the surface (deduped per-surface;
//     a story CAN appear in multiple surfaces by design — e.g. hero
//     and entitled_row at the same time)
export async function addToSurface(
  surface: string,
  storyId: string,
): Promise<CurationResult> {
  if (!isHomepageSurface(surface)) {
    return { ok: false, error: `unknown surface: ${surface}` };
  }
  if (!storyId || typeof storyId !== "string") {
    return { ok: false, error: "missing story_id" };
  }
  const existing = await listSurface(surface);
  const dupe = existing.find((r) => r.story_id === storyId);
  if (dupe) {
    return {
      ok: false,
      error: `story ${storyId} is already in ${surface} at position ${dupe.position}`,
    };
  }
  const cap = SURFACE_CAPACITY[surface];
  if (cap !== null && existing.length >= cap) {
    return {
      ok: false,
      error: `${surface} is full (${cap}/${cap}) — remove an entry first`,
    };
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const position = existing.length;
  await run(
    "INSERT INTO homepage_curation (id, surface, position, story_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
    [id, surface, position, storyId, now, now],
  );
  const row: CurationRow = {
    id,
    surface,
    position,
    story_id: storyId,
    created_at: now,
    updated_at: now,
  };
  return { ok: true, row };
}

// Remove a story from a surface and densify positions so the next add
// targets a clean tail. Sequential rather than transactional because the
// dual-driver layer in lib/db.ts doesn't expose a transaction primitive
// — this is the same pattern the queue helpers use. A race with
// addToSurface could briefly produce a gap, but the next add still
// claims `existing.length` and the next call to listSurface still
// orders by position correctly. The unique index is on (surface,
// position), so a position collision would surface as an INSERT error
// the caller would see, not silent corruption.
export async function removeFromSurface(
  surface: string,
  storyId: string,
): Promise<{ ok: boolean; error?: string; removed?: CurationRow }> {
  if (!isHomepageSurface(surface)) {
    return { ok: false, error: `unknown surface: ${surface}` };
  }
  const rows = await listSurface(surface);
  const target = rows.find((r) => r.story_id === storyId);
  if (!target) {
    return { ok: false, error: `${storyId} not in ${surface}` };
  }
  await run("DELETE FROM homepage_curation WHERE id = ?", [target.id]);
  const survivors = rows.filter((r) => r.id !== target.id);
  // Pack positions to remove the gap. Only touch rows whose position
  // would change.
  const now = new Date().toISOString();
  for (let i = 0; i < survivors.length; i++) {
    if (survivors[i].position !== i) {
      await run(
        "UPDATE homepage_curation SET position = ?, updated_at = ? WHERE id = ?",
        [i, now, survivors[i].id],
      );
    }
  }
  return { ok: true, removed: target };
}

// Swap a story with its neighbour in the given direction. No-op (returns
// ok: true) when the story is already at the boundary so the admin UI
// can call this on every up/down click without error-handling the edge.
export async function moveInSurface(
  surface: string,
  storyId: string,
  direction: "up" | "down",
): Promise<{ ok: boolean; error?: string }> {
  if (!isHomepageSurface(surface)) {
    return { ok: false, error: `unknown surface: ${surface}` };
  }
  if (direction !== "up" && direction !== "down") {
    return { ok: false, error: `invalid direction: ${direction}` };
  }
  const rows = await listSurface(surface);
  const idx = rows.findIndex((r) => r.story_id === storyId);
  if (idx === -1) {
    return { ok: false, error: `${storyId} not in ${surface}` };
  }
  const neighbourIdx = direction === "up" ? idx - 1 : idx + 1;
  if (neighbourIdx < 0 || neighbourIdx >= rows.length) {
    // Already at the edge — silent no-op so the admin button is safe to
    // click at any position.
    return { ok: true };
  }
  const a = rows[idx];
  const b = rows[neighbourIdx];
  const now = new Date().toISOString();
  // Two writes with the unique index in play: the second write would
  // collide if we just swapped positions directly. Park `a` at position
  // -1 (a value the surface never uses) for the duration of the swap so
  // both updates can land cleanly.
  await run(
    "UPDATE homepage_curation SET position = -1, updated_at = ? WHERE id = ?",
    [now, a.id],
  );
  await run(
    "UPDATE homepage_curation SET position = ?, updated_at = ? WHERE id = ?",
    [a.position, now, b.id],
  );
  await run(
    "UPDATE homepage_curation SET position = ?, updated_at = ? WHERE id = ?",
    [b.position, now, a.id],
  );
  return { ok: true };
}
