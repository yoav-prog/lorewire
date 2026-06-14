# Public-site curation system

**Status:** Phases 1-4 shipped 2026-06-15
**Owner:** Yoav (info@flexelent.com)
**Date:** 2026-06-15
**Trigger:** Front page Billboard + all rails are hardcoded in [src/lib/stories.ts](lorewire-app/src/lib/stories.ts). The CMS overlay grafts pipeline-generated stories on top of the static catalog but does not change which IDs occupy which slot. There are no category pages. Admin has zero control over what appears where.

## Goals

- Admin picks which story appears in the Billboard, in each rail (Top 10 / Continue / New / Entitled), and on each category page.
- Drag-and-drop ordering within each slot.
- Per-story view: "which slots is this story in?" — directly from the story editor.
- Optional scheduling (`publish_at` / `expires_at`) so a story can be pre-staged for tomorrow or auto-expire on a date.
- Category pages: pinned stories first (admin-curated order), then auto-fill with the rest of the category's published stories newest-first.

## Non-goals (for now)

- A/B testing different slot picks.
- Personalization (everyone sees the same slots).
- Streaming editorial preview (live updates as admin reorders — refresh is enough).
- Migration of editor-side curation history (this is greenfield).

## Architecture

**One table** — `curation_slots`. Rows are individual (slot, story) placements:

```sql
CREATE TABLE curation_slots (
  id            TEXT PRIMARY KEY,
  slot_kind     TEXT NOT NULL,    -- 'billboard.featured', 'rail.top10', 'category.Drama', etc.
  position      INTEGER NOT NULL, -- 0-based order within slot_kind
  story_id      TEXT NOT NULL,
  publish_at    TEXT,             -- ISO; NULL = active immediately
  expires_at    TEXT,             -- ISO; NULL = no expiry
  notes         TEXT,             -- admin annotation
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (slot_kind, story_id)    -- one story can't occupy the same slot twice
);
CREATE INDEX idx_curation_slots_kind_pos ON curation_slots(slot_kind, position);
CREATE INDEX idx_curation_slots_publish  ON curation_slots(publish_at, expires_at);
```

**Slot kind registry** (lives in TS, mirrored in Python):

| Slot kind | Used by | Cardinality |
|---|---|---|
| `billboard.featured` | Mobile Billboard + Desktop Hero | Singleton (1 story) |
| `rail.continue` | "Continue Watching" rail | Many (~4–10) |
| `rail.top10` | "Top 10 Today" rail | Many (10) |
| `rail.new` | "New" rail | Many (~6–10) |
| `rail.entitled` | "Entitled" rail | Many (~6) |
| `category.Drama` | `/c/drama` page | Pinned + auto-fill |
| `category.Entitled` | `/c/entitled` page | Pinned + auto-fill |
| `category.Humor` | `/c/humor` page | Pinned + auto-fill |
| `category.Wholesome` | `/c/wholesome` page | Pinned + auto-fill |
| `category.Dating` | `/c/dating` page | Pinned + auto-fill |
| `category.Roommate` | `/c/roommate` page | Pinned + auto-fill |

Category pages prepend curation_slots rows in order, then auto-fill the remaining feed with `SELECT * FROM stories WHERE status='published' AND category=? ORDER BY published_at DESC`. Same story isn't shown twice — the auto-fill skips IDs already pinned.

**Fallback behaviour.** If a slot has zero curation_slots rows AND we have published stories for that slot's logical filter, fall back to the legacy hardcoded list. Once admin pins ANY story in a slot, the hardcoded list is ignored. Migration story: admin opens the curation page on first run, all slots show the legacy IDs as suggestions; one click "Adopt current" copies them to the table so they become editable. Greenfield slots (no legacy) start empty.

## Phases

Each phase independently mergeable. Each ends with a deploy + a manual smoke check on the live site.

### Phase 1 — Schema + helpers (Python + TS)

- `pipeline/store.py` SCHEMA_STATEMENTS: add `curation_slots` + indexes.
- `pipeline/store.py` helpers:
  - `list_curation_slots(slot_kind, *, active_at=None) -> list[dict]`
  - `set_slot_stories(slot_kind, story_ids: list[str], notes: str | None = None)` — atomic replace
  - `add_to_slot(slot_kind, story_id, position=None)` — append by default
  - `remove_from_slot(id)`
  - `reorder_slot(slot_kind, ordered_ids)` — bulk position update
- `lorewire-app/src/lib/schema.ts`: mirror `curation_slots` in TABLES + add the `(slot_kind, story_id)` UNIQUE in `POST_TABLE_DDL`.
- `lorewire-app/src/lib/curation.ts`: TS mirrors of the Python helpers + reads:
  - `listSlots(slotKind): Promise<CurationSlot[]>`
  - `listAllSlots(): Promise<Record<string, CurationSlot[]>>` — admin UI
  - `setSlotStories(slotKind, storyIds[]): Promise<void>`
  - `getActivePicks(slotKind, now: Date): Promise<string[]>` — what the public page reads
- Tests: 8 Python (CRUD + ordering + active-at filter), 6 TS (same shape against the dual-driver SQLite).

### Phase 2 — Admin curation page

- New route `/admin/curation` (panel).
- Section per slot_kind, with chip-grid of pinned stories (hero thumbnail + title) + drag-to-reorder.
- "Add story" search modal that searches across published stories by title.
- Per-row `publish_at` / `expires_at` / `notes` inline editors.
- Sidebar entry "Curation" in `AdminSidebar.tsx`.
- Server actions: `setSlotStoriesAction`, `addToSlotAction`, `removeFromSlotAction`, `reorderSlotAction`. Each `requireAdmin` + revalidates `/`, `/c/*`, `/admin/curation`.
- Drag-and-drop via [dnd-kit](https://dndkit.com/) — small, no-jQuery, MIT, well-maintained. Adds ~25 KB to the admin bundle. (Per CLAUDE.md rule 8: free, MIT-licensed.)
- Tests:
  - Server actions are admin-gated.
  - Reorder action persists positions correctly.
  - Adding the same story twice to the same slot is rejected via the UNIQUE constraint with a clear flash.

### Phase 3 — Category page route

- New route `lorewire-app/src/app/c/[category]/page.tsx`.
- Static-rendered (force-static + revalidate every 60s) so the public read is cache-fast.
- Reads pinned stories from curation_slots WHERE slot_kind = `category.<Category>` AND active, then auto-fills remaining published stories of that category newest-first.
- Same poster grid as the home page's category rail, just paginated/lazy-loaded.
- 404 for unknown categories.
- Tests: route compiles for each of the 6 categories, pinned rows render in admin order, unpinned auto-fill respects ORDER BY published_at DESC.

### Phase 4 — AppShell wiring

- AppShell + DesktopShell currently `"use client"`. The fastest path: keep them client, but `Page` (the server component at `src/app/page.tsx`) reads the curation slots and passes them down as initial props.
- Hardcoded arrays in `lib/stories.ts` (`CONTINUE`, `TOP10`, `ENTITLED_ROW`, `NEW_ROW`, `byId("envelope")`) become FALLBACKS, only used when the corresponding slot has zero pinned rows.
- The CMS overlay continues to apply on top so the curated stories pick up their published bodies / heroes.
- Tests: server-side resolver returns the right ID list per slot; falls back to hardcoded when slot empty.

### Phase 5 — Per-story "appears in" panel

- New sidebar on `/admin/stories/[id]` showing every slot this story is in.
- Inline "add to slot" multi-select.
- Useful for the admin's flow when they just published a story and want to immediately place it.

### Phase 6 — Scheduling + auto-fill

- Wire the `publish_at` / `expires_at` columns to the read path: only slots active at `now` are returned.
- Add an "auto-fill remainder" toggle per rail so the admin can pin the top 3 manually and let the remaining 7 of Top 10 auto-fill by published_at DESC.
- Cron sweep (`/api/cleanup_curation_expired`) that hard-deletes long-expired slot rows so the table doesn't grow unbounded.

## Security (rule 13)

- All curation_slots writes go through admin actions that call `requireAdmin()` first.
- Reads are public (the public page reads them).
- `slot_kind` must validate against the registered list — block writes for arbitrary kinds so a typo doesn't silently land in a dead slot.
- `story_id` must reference an existing `stories.id` AND that story must have `status='published'` at write time. (We allow scheduling out — admin can pin a story BEFORE publishing — but log a warning if it's not published yet.)

## Observability (rule 14)

Namespaced logs:
- `[curation list]` — public page reads (slot kind, count returned).
- `[curation write set]` / `add` / `remove` / `reorder` — admin mutations (action + counts + actor).
- `[curation fallback]` — slot empty, falling back to hardcoded list.

Future Phase 6 cron: `[curation cleanup-expired] removed=N`.

## Settings (rule 15)

- `curation.auto_fill_enabled` (default true): when a rail's pinned set is shorter than its target length, fill the remainder by `published_at DESC`. Admin can disable for a strict-curation mode.
- `curation.publish_required_for_pinning` (default true): block pinning a story that isn't in `status='published'`. Admin can disable for staging.

## Testing (rule 18)

- Phase 1: 8 Python + 6 TS unit tests on the helpers.
- Phase 2: 4 TS tests on the server actions (auth, reorder persistence, UNIQUE conflict surfacing, revalidate paths).
- Phase 3: 1 vitest snapshot per category route.
- Phase 4: 1 server-side resolver test confirming the public page gets the right IDs.
- Phase 6: 1 test for the active-at filter.

## What lands when

| Phase | Visible to admin? | Visible on public site? |
|---|---|---|
| 1 — Schema | No | No |
| 2 — Admin page | Yes (curation tools work) | No (still hardcoded) |
| 3 — Category pages | — | Yes (new `/c/<cat>` pages render) |
| 4 — AppShell wiring | — | Yes (Billboard + rails reflect admin choices) |
| 5 — Per-story panel | Yes (faster placement workflow) | — |
| 6 — Scheduling | Yes (publish_at / expires_at + auto-fill) | Yes (slot expiry takes effect) |

End state: admin picks every story on the home page and category pages, with order + schedule. Hardcoded lists become safety-net defaults that surface only when a slot is empty.
