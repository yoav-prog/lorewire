# Admin reorganization Phase 2: Settings hub + sidebar trim + Videos page

Date: 2026-06-12
Status: Approved — ready to execute
Supersedes (in scope, not history): the Phase 2/3/4 sequencing in
`_plans/2026-06-11-admin-reorg.md`. Phase 1 (sidebar shell + breadcrumbs)
already shipped and is in `847f7a3` on `main`.

## What changed since the original plan

After eyeballing Phase 1, the user pushed back on three things:

1. **"Pipeline" is internal jargon.** The sidebar item should read **Settings**,
   not Pipeline. The Python pipeline reads `settings_kv` but that's an
   implementation detail; the user-facing label is "Settings."
2. **Configuration sprawled across four sidebar items.** Models, Captions
   (Templates), Intros & outros, and Pipeline (Settings) all live as siblings.
   They are all "configuration." Should be one Settings entry with internal
   category sub-nav.
3. **"Inbox" was opaque** as a label. The unified content feed concept didn't
   land.
4. **Videos sidebar item linked to a filtered Inbox URL.** No dedicated list
   page, so the user clicked "Videos" and the destination didn't feel like a
   Videos page.

User answers (via AskUserQuestion in this conversation):

- Sidebar shape: **Overview / Articles / Videos / Settings** (4 entries).
- Videos behavior: **dedicated `/admin/videos` list page**, click-through to
  existing `/admin/videos/[id]` editor.
- Re-render videos and images: **separate branch and plan** — see
  `_plans/2026-06-12-asset-rerender.md`.
- "Edit published" symptom: none — the user wanted to confirm it works. I
  verified at the data layer that nothing blocks editing of published items;
  no action needed beyond the reorg.

## Goal

Trim the sidebar to four entries, fold all configuration into one Settings
hub with a category sub-nav, add a dedicated Videos list page, regroup the
17-field Settings/General page into clear named sections with plain-English
helper text. Keep every URL alive — `/admin/models`, `/admin/templates`, and
`/admin/segments` keep working as deep links but render inside the Settings
shell with the right category active.

## Constraints

- **No removals.** Every URL still responds. Stories renames to Videos in the
  sidebar but `/admin/stories` keeps working as a deep link (it remains a
  thin wrapper around the same list shell as `/admin/videos`).
- **No visual redesign of the brand language.** Same design tokens. The
  Settings page gets clearer section structure and helper text but no new
  font, no new color, no new icon library.
- **No new paid services.** Pure code change.
- **One PR, one diff.** Re-render work is its own plan and its own branch.

## Chosen approach

### Sidebar (final shape)

Flat list, no group labels (only 4 items — group labels are noise):

```
+------------------+
| LOREWIRE Studio  |
+------------------+
| OVERVIEW         |
| ARTICLES         |
| VIDEOS           |
| SETTINGS         |
+------------------+
| (DEV)            |  only when NODE_ENV !== 'production'
|  Player spike    |
+------------------+
```

The "Inbox" / unified Content view is no longer surfaced in the sidebar but
`/admin/content` still responds for the cross-kind power use case.

### Settings hub

`/admin/settings` becomes the canonical Settings entrypoint. It renders a
two-column page:

- **Left sub-nav (sticky):** General · Models · Intros & outros
- **Right content area:** the active category's content.

**Captions are intentionally not a Settings sub-nav category.** Per the
user's "captions need to be part of the video editor and not their own
page" feedback, the per-video caption editor moves into the video editor
(see Phase 3, below). The `/admin/templates` URL still responds — kept
alive for deep-link compatibility and as the fallback for global/category
caption defaults — but it doesn't appear in the Settings sub-nav.
Settings/General gets a single muted "Caption defaults" link card that
points at `/admin/templates`; it's the only UI entry-point to that page.

Each remaining category is still its own URL so deep links work:

| URL                | Category           | Active sub-nav item   |
| ------------------ | ------------------ | --------------------- |
| `/admin/settings`  | General            | General               |
| `/admin/models`    | Models             | Models                |
| `/admin/segments`  | Intros & outros    | Intros & outros       |
| `/admin/templates` | (deep-link only)   | — (no sub-nav entry)  |

Implementation: a new `<SettingsShell active="general|models|intros">`
server component wraps each of the three pages. The shell renders the
sub-nav on the left, the children (the category content) on the right.
Each route file renders `<SettingsShell active="...">{categoryContent}</SettingsShell>`.
`/admin/templates` renders standalone (no shell) so it stays usable but
doesn't pretend to be a Settings category.

### Settings/General regrouped

The 17-field wall splits into clearly titled, visually separated sections:

- **Pipeline** — `pipeline.subreddit`, `pipeline.limit`, `budget.daily_usd`
- **Voice** — `voice.google_voice_name`, `voice.google_style_prompt`,
  `voice.elevenlabs_voice_id`
- **Video look** — `video.style`, `media.scene_count`, `video.ken_burns`,
  `video.micro_wiggle`, `video.label_pop`, `video.scribble_draw`,
  `video.prop_slide`, `media.prop_count`, `video.mouth_swap`
- **Intro/outro splice** — `video.intro_outro_enabled`

Sections are visual groupings (heading + short description + cards inside);
they don't collapse. Collapsing hides content from a lazy user looking for
a setting; better to just give clear visual hierarchy.

Field labels move from ALL-CAPS-MONO to **Sentence case** with a small
muted helper line. Per-field Save buttons stay (atomic, low-risk) but the
visual weight shifts so the field label is what the eye lands on, not the
button.

### Videos list page

New file `src/app/admin/(panel)/videos/page.tsx`. Server component, lists
stories using the existing `listStoriesSlim` repo function, renders the same
filter chips (status) as `/admin/stories`. Each row's "click" target stays
`/admin/stories/[id]` (the per-video edit page that already exists) — note
that there are two video-editor surfaces: the metadata/status editor at
`/admin/stories/[id]` (inside `(panel)`, sidebar shell) and the full-bleed
visual editor at `/admin/videos/[id]` (outside `(panel)`). The list page
rows go to the visual editor by default; a small "Edit metadata" secondary
action goes to the metadata page.

`/admin/stories` keeps working unchanged for now (separate route, separate
file). Phase 3 (later) can collapse `/admin/stories` to delegate to the
videos list shell.

Next.js routing note: `src/app/admin/(panel)/videos/page.tsx` provides URL
`/admin/videos`, while `src/app/admin/videos/[id]/page.tsx` provides URL
`/admin/videos/[id]`. These URLs are distinct, so Next.js resolves them
independently. The list page picks up the `(panel)` layout (sidebar shell);
the editor stays outside the route group and remains full-bleed.

### URL routing summary

```
/admin                        Overview (sidebar shell)
/admin/articles               Articles list (sidebar shell)
/admin/articles/[id]          Article editor (sidebar shell, with Breadcrumb)
/admin/articles/new           Unchanged
/admin/articles/import        Unchanged
/admin/videos                 NEW Videos list (sidebar shell)
/admin/videos/[id]            Visual video editor (full-bleed, unchanged)
/admin/stories                Existing story list (sidebar shell) — kept as deep-link alias
/admin/stories/[id]           Story metadata editor (sidebar shell, with Breadcrumb)
/admin/content                Unified mixed feed (sidebar shell) — kept, not surfaced in nav
/admin/settings               Settings/General (sidebar shell + Settings sub-nav)
/admin/models                 Settings/Models (sidebar shell + Settings sub-nav)
/admin/templates              Settings/Captions (sidebar shell + Settings sub-nav)
/admin/segments               Settings/Intros & outros (sidebar shell + Settings sub-nav)
```

## Phasing

Phase 2 is one shippable unit. Substeps for execution order:

**2a. SettingsShell + sub-nav** — new `<SettingsShell>` server component,
wrap each of the three config routes with it (Settings/General, Models,
Intros & outros). `/admin/templates` is intentionally NOT wrapped — it's
standalone deep-link-only. Visual: sticky left sub-nav, right content
area.

**2b. Settings/General regroup** — break the 17-field array into named
sections (Pipeline, Voice, Video look, Intro/outro splice). Sentence-case
labels, muted helper lines. Add a "Caption defaults" link card linking to
`/admin/templates`.

**2c. Sidebar trim** — `AdminSidebar` shrinks to Overview / Articles /
Videos / Settings (plus Dev). Update the `AdminSidebar` test fixture.

**2d. Videos list page** — `src/app/admin/(panel)/videos/page.tsx`,
delegates to the same listing shape as `/admin/stories` but with rows
pointing at `/admin/videos/[id]` for the visual editor.

**2e. Master switch on Intros & outros page** — surface the
`video.intro_outro_enabled` field inline on the Intros & outros page (was
Phase 3 in the v1 plan; lands now since the user is already eyeballing the
config surfaces).

**2f. QA + tests + lint + push.**

### Phase 3 (next, not bundled here)

**Embed per-video captions in the video editor.** The visual editor at
`/admin/videos/[id]` gets a Captions panel that edits the per-story scope
(the same `caption.story.<id>.*` settings keys today's `/admin/templates`
story-scope tab writes to). UX bar: discoverable from the editor surface,
no nav detour, live preview on the same screen. The exact shape (tab vs.
drawer vs. inspector panel) lands in a Phase 3 sub-plan once the existing
editor tab structure is mapped. The user's exact ask:

> by the way the captions need to be part of the video editor and not
> their own page, but embed it there in a smart, ui ux friendly way,
> intuitive and beautiful

Lands as its own commit in this same reorg branch, after 2f is green.

## Lazy-user walkthrough (rule 10)

- Lands on `/admin` → Overview, sees stats and recent. Clicks Open Inbox →
  goes to `/admin/content` (the mixed feed). *Open question: should the
  Overview's primary CTA point at `/admin/videos` instead, since Videos is
  now the primary destination? Resolve during 2a — pick the highest-traffic
  destination for the user's actual workflow.*
- Clicks Articles → list of articles, filters work, "+ New article" top-right.
- Clicks Videos → list of all videos (stories) with status filter, clicks a
  row → lands on the visual editor at `/admin/videos/[id]` (full-bleed).
  "Edit metadata" secondary action goes to `/admin/stories/[id]` if they
  want to change category/title/status.
- Clicks Settings → Settings/General with the four-category sub-nav on the
  left, the 17 fields cleanly grouped into Pipeline / Voice / Video look /
  Intro-outro splice. Clicks Models in the sub-nav → URL flips to
  `/admin/models`, content swaps to model selection, sub-nav highlights
  Models. Same for Captions and Intros & outros.
- On Intros & outros sub-page → master on/off switch is inline at the top
  (no detour to Settings/General).
- On mobile → sidebar drawer holds the same 4 items. Sub-nav inside
  Settings becomes a top scroll row (`md:left-col, narrow:top-row`).

## Security (rule 13)

- Auth unchanged: `requireAdmin()` on the panel layout + each server action.
- Settings sub-nav is purely client routing; no new attack surface.
- Master switch on Intros & outros writes through the existing
  `saveSettingAction` — same validation, same auth.
- No new external calls.

## Observability (rule 14)

Namespaced logs added to the new code:

- `[admin settings shell] render` — `{ active, user_id }`.
- `[admin sidebar] route` — already exists from Phase 1; the test fixture
  updates with the new groups.
- `[admin videos list] render` — `{ status_filter, row_count }`.

## Settings audit (rule 15)

No new persistent settings introduced by this work. Existing
`settings_kv` keys are unchanged; only the UI grouping changes.

Settings explicitly *not* introduced (and why):
- Settings page collapse states: visual sections don't collapse (rule 10 —
  lazy user wants to see what's available).
- Sub-nav order: hardcoded.

## Testing (rule 18)

- `SettingsShell.test.tsx` — sub-nav active state for each `active` value,
  all four sub-nav items render, links resolve to the right URLs.
- `AdminSidebar.test.ts` — updated fixture: 4 items + optional Dev group.
  Old fixture tested 8 items across 3 groups; replaces wholesale.
- `videos/page.test.ts` — page renders rows from `listStoriesSlim`, status
  filter chips wire through.
- All existing tests must stay green (244 currently). One settings
  regression risk: the field grouping must not change which `key`s are
  written by each form — verified by ensuring each form's `<input
  type="hidden" name="key" value="...">` is unchanged in the regroup.

## Rejected alternatives

- **Settings as nested URL routes** (`/admin/settings/models`,
  `/admin/settings/captions`, ...). Cleaner mental model in some ways but
  breaks every existing deep link. Rule says no removals.
- **Accordion sections in Settings/General.** Hides options behind extra
  clicks. Lazy user (rule 10) sees less, not more.
- **Combining Stories + Videos into one URL** by 301-ing `/admin/stories`
  → `/admin/videos`. Tempting but a 301 is a removal in spirit; deep links
  start landing on URLs the user didn't ask for.

## File touch list

New:
- `src/app/admin/SettingsShell.tsx`
- `src/app/admin/SettingsShell.test.tsx`
- `src/app/admin/(panel)/videos/page.tsx`
- `src/app/admin/(panel)/videos/page.test.ts`

Modified:
- `src/app/admin/AdminSidebar.tsx` — 4-item shape.
- `src/app/admin/AdminSidebar.test.ts` — new fixture.
- `src/app/admin/(panel)/settings/page.tsx` — SettingsShell + grouped
  fields + Caption defaults link card.
- `src/app/admin/(panel)/models/page.tsx` — wrapped in SettingsShell.
- `src/app/admin/(panel)/segments/page.tsx` — wrapped in SettingsShell +
  inline master switch.

Intentionally unchanged in Phase 2:
- `src/app/admin/(panel)/templates/page.tsx` — stays standalone, no shell.
  Phase 3 moves per-video caption editing into the video editor; this
  page remains as a deep-link surface for global/category defaults.

Unchanged but worth listing (verified, no edits needed):
- `src/app/admin/(panel)/layout.tsx` — already Phase-1 final.
- `src/app/admin/(panel)/page.tsx` — keeps its Open Inbox link; trivial
  update may land in 2a if we point Overview at a better default.
- `src/app/admin/videos/[id]/page.tsx` — the full-bleed editor stays as-is.
