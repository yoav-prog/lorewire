# Homepage curation — admin-driven catalog

Date: 2026-06-16
Owner: Yoav (info@flexelent.com)
Status: Proposed — awaiting go-ahead before implementation.

## Goal

Let an admin choose which stories appear on the public homepage rails — Hero, TOP 10, the category rows (Entitled, New & Hot, etc.), and Continue Watching — without editing source files or redeploying.

Today, those rails are hardcoded arrays in [lorewire-app/src/lib/stories.ts](lorewire-app/src/lib/stories.ts) (`TOP10`, `ENTITLED_ROW`, `NEW_ROW`, `CONTINUE`). Every change is a code edit + git commit + Vercel build. That works for a fixed sample catalog; it won't scale once the Reddit pipeline starts producing dozens of new stories per week.

## Constraints

- Stay live: curation edits must land on the next page load. No re-export step, no rebuild.
- Manual picks only (user choice). No auto-fill rules — admin is always in full control of what shows where.
- All four surfaces are curated: Hero (1 pick), TOP 10 (10 picks ordered), category rows (~6 picks each, ordered), Continue Watching (treated as editor-controlled rail, not per-user).
- Curation must survive a story being deleted or unpublished — broken refs get filtered out at read time, not crash the rail.
- Public read path must NOT leak draft/archived/noindex stories even if they end up in the curation table by mistake.

## Data model

New table: `homepage_curation`

| column        | type    | notes |
|---------------|---------|-------|
| id            | TEXT    | UUID primary key |
| surface       | TEXT    | one of: `hero`, `top10`, `continue`, plus one row per category (`entitled_row`, `new_row`, etc.) |
| position      | INTEGER | 0-based slot within the surface |
| story_id      | TEXT    | FK to `stories.id` (logical; we don't enforce FK since cross-engine portability) |
| created_at    | TEXT    | ISO-8601 |
| updated_at    | TEXT    | ISO-8601 |

Constraints:
- UNIQUE(surface, position) so two stories can't claim slot 0
- INDEX(surface) for fast row reads

Surfaces are not enforced via CHECK constraint — the admin page enumerates the valid set and the API rejects unknown surface values. Keeps the schema flexible if we add a rail later.

## Admin UI

New page: `/admin/curation`

Layout: one card per surface, top to bottom in the order they appear on the homepage. Each card shows:
- Surface name + slot count (e.g. "TOP 10 — 10 / 10 filled")
- An ordered list of the currently curated stories (thumbnail + title + category chip + ↑/↓ reorder + ✕ remove)
- An "Add story" picker — autocomplete over `listPublishedStories()` filtered to published + non-noindex; clicking adds at the end
- Empty-slot indicator for surfaces with a fixed capacity (Hero=1, TOP 10=10)

Bulk ops out of scope for v1 — single add/remove/reorder per click is enough.

## Server actions

In `lorewire-app/src/app/admin/(panel)/curation/actions.ts`:
- `loadCuration()` → `Record<Surface, CuratedStory[]>` — for the admin page server render
- `addToSurface(surface, storyId)` — appends to the end
- `removeFromSurface(surface, storyId)` — removes, re-densifies positions
- `moveInSurface(surface, storyId, direction: 'up' | 'down')` — swap adjacent
- `listAvailableStories()` — published stories not currently in any surface (or include with a "(in TOP 10)" label so duplicates are visible but not blocked)

All gated by `requireAdmin()`. All log namespaced `[admin curation ...]` per rule 14. All `revalidatePath('/')` on success so the public homepage picks up the change.

In `lorewire-app/src/app/actions.ts` (extends today's file):
- `getHomepageCuration()` → `{ hero: Story|null, top10: Story[], continue: Story[], entitledRow: Story[], newRow: Story[] }` — joined against `listPublishedStories` so each entry has enough fields to render a card (id, title, category, hero_image, duration, video_url, slug). Filters out anything that's not currently published.

## Public read path

`DesktopShell` (client component) calls `getHomepageCuration()` once on mount, then renders rails from the result instead of the hardcoded `TOP10`/`ENTITLED_ROW`/`NEW_ROW`/`CONTINUE` constants.

Fallback: when the curation is empty for a surface (e.g. nothing curated yet, or all curated stories got unpublished), the rail uses today's hardcoded constants so the homepage never goes blank during the transition. Logged as `[lorewire curation fallback]` so we can see when it's happening.

Same shape as today's `getLiveStoryVideoUrl` fetch — additive, fails open.

## Migration

- New table created via the existing `schema.ts` registry + `ensureSchema` migration step. No data migration; rails default to empty and the fallback to hardcoded constants keeps the site looking the same.
- Once we've manually populated the curation for each surface via the admin UI, we can delete the hardcoded constants in a follow-up PR.

## Settings audit (rule 15)

- Setting: `curation.empty_rail_behavior` — `"fallback"` (use hardcoded constants) or `"hide"` (don't render the rail at all). Default: `"fallback"` to preserve current visual.
- Setting: `curation.hero_required` — when true, the page renders the hero from the curation; when false, falls back to today's `byId("envelope")` hero. Default: `false` so a new install isn't broken before curation is set up.

Group both under a new **Settings → Homepage** section.

## Observability (rule 14)

- Every admin action logs `[admin curation <op>]` with `{ surface, story_id, user_id }`
- Public fetch logs `[lorewire curation load]` with `{ counts_per_surface, fetch_ms }`
- Fallback logs `[lorewire curation fallback]` with `{ surface, reason: "empty" | "all-unpublished" }`
- Stale-ref drops log `[lorewire curation stale]` with `{ surface, story_id }` so we can see how often curated stories get unpublished

## Security (rule 13)

- All admin actions gated by `requireAdmin()`
- Public action returns only `status='published' AND published_at IS NOT NULL AND (noindex IS NULL OR noindex = 0)` rows
- Surface enum validated at the action layer; unknown surfaces rejected
- Position math (move/remove) runs in a transaction so a concurrent edit can't leave gaps

## Testing (rule 18)

- Vitest: position math (add, remove, move up/down) on a fixture curation
- Vitest: public read filters drafts/noindex/unpublished
- Vitest: empty-surface fallback path
- E2E via Playwright (deferred to follow-up): admin adds, removes, moves; homepage reflects

## Alternatives considered

1. **Auto-fill from rules (most recent N in category)**. Cheaper to operate but loses editorial control over what's "featured." User explicitly rejected this — manual picks only.
2. **Settings keys (JSON arrays of ids)**. Lower ceremony than a new table, but loses the per-slot UNIQUE constraint, makes reorder a re-write of the whole array, and clutters the settings surface with 6+ keys. Rejected for v1.
3. **Per-story `featured_in` column**. Simple but lossy on ordering and can't represent a story being in TWO surfaces. Rejected.
4. **Bake curation into `published.ts`**. Same edit-loop problem we just fixed for `video_url`. Rejected.

## Phases

1. **Schema + storage helpers** — `homepage_curation` table, position math, transactions. Test-first.
2. **Public read action + DesktopShell wiring** — `getHomepageCuration()`, hook into the rails, fallback path, observability.
3. **Admin UI** — `/admin/curation` page, server actions, picker.
4. **Settings hooks** — `curation.empty_rail_behavior`, `curation.hero_required`. Settings → Homepage section.
5. **Cleanup** *(landed)* — TOP10 / ENTITLED_ROW / NEW_ROW / CONTINUE constants deleted from `lib/stories.ts`. Rail resolution moved into a shared `lib/homepage-rails` module (hook + pure `resolveRailIds` + `CATEGORY_RAILS`) consumed by both DesktopShell and MobileShell. Fallback now auto-derives a sensible default from STORIES (slice 10 for TOP10, sort by year for "New", filter by category for category rails) so the rollout safety net still works without a manual constant list.

Each phase ships behind a single PR, no flag — fallback path keeps things safe.

## Open questions (resolved 2026-06-16)

- **Category rows in v1:** every active category gets a row — `entitled_row`, `humor_row`, `wholesome_row`, `dating_row`, `roommate_row`, `drama_row`. Plus the existing `new_row` (cross-category "fresh threads" rail).
- **Stale curation entries:** keep in the table. Admin page surfaces unpublished/missing entries with a warning chip so the user can decide whether to remove or republish; public read filters them out silently.
- **Continue Watching:** flat editor-curated rail for now. When user accounts ship later, that surface can switch to per-user state without touching the rest of this schema.
