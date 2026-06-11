# Admin reorganization: Sidebar Studio

Date: 2026-06-11
Author: yoavm7-code (with Claude)
Status: Approved — ready to execute

## Goal

Reorganize the admin into a single, deliberate "studio" surface. Stop duplicating
list chrome across pages, stop scattering configuration across four sibling tabs,
stop shipping a self-described throwaway spike route in production, and give the
user a clear back-affordance from every editor inner page. Keep every existing
route working (deep links and bookmarks unbroken) and keep every existing feature
reachable.

The user's words: "look at the admin, it's a mess and not organized. Please do a
robust organization. don't remove anything, just unify what needs to be unified
and think of robust beautiful UI UX FRIENDLY admin panel."

## Constraints

- **No removals.** Every route currently in the tree keeps responding. Behind-the-
  scenes that means a route file can become a thin wrapper that defers to a
  shared shell, but it cannot 404 a URL that worked before.
- **No visual redesign.** Same LOREWIRE/Studio brand language, same design tokens
  (`border-line`, `bg-bg`, `text-ink`, `text-muted`, `text-accent`, font-display,
  font-mono). This is structural reorganization, not a re-skin.
- **No new paid services.** Pure code change. No external API costs, no model
  changes, no infra.
- **Next.js conventions.** Per `AGENTS.md`: this is not training-data Next.js.
  Read `node_modules/next/dist/docs/` (and consult Context7 per rule 9) before
  introducing any new framework API. Server components stay server components;
  the new sidebar is the only place we need a `"use client"` boundary, and only
  to keep an active-route check and a mobile drawer toggle.

## Requirements

The new admin must satisfy:

1. **One canonical inbox.** `/admin/content` is the unified hub. `/admin/stories`
   and `/admin/articles` keep working but render the same component with a kind
   preset. Zero duplicated list chrome.
2. **One canonical configuration zone** in the nav, grouping Models, Captions
   (formerly "Templates"), Intros & outros, and Pipeline (formerly "Settings").
3. **One canonical content zone** in the nav: Inbox, Articles, Stories, Videos.
4. **Breadcrumbs on every editor inner page** so a lazy user can get back without
   reaching for browser-back.
5. **Spike route gated to non-production.** The file stays, the URL returns 404
   in prod.
6. **Mobile drawer.** The sidebar collapses to a hamburger drawer below `md`.
7. **Master switch on the page it controls.** The intro/outro master switch
   stays writeable from `/admin/settings` (zero-removal) but also surfaces
   directly on `/admin/segments` so the admin never has to leave the page they
   were on.
8. **Pipeline settings grouped.** The 17-field wall on `/admin/settings` splits
   into named sections (Pipeline, Voice, Video look, Captions overlay, Splice).

## Chosen approach (Option B: Sidebar Studio)

### IA

```
+----------------------------------------------------------------+
| LOREWIRE Studio          [Cmd K stub]   user-menu   sign out  |
+----------+-----------------------------------------------------+
| OVERVIEW |                                                     |
|          |                                                     |
| CONTENT  |   <breadcrumb>                                      |
|  Inbox   |   <page title slot>                                 |
|  Articles|                                                     |
|  Stories |   <page body>                                       |
|  Videos  |                                                     |
|          |                                                     |
| CONFIG   |                                                     |
|  Models  |                                                     |
|  Captions|                                                     |
|  Intros  |                                                     |
|  Pipeline|                                                     |
|          |                                                     |
| DEV*     |   * only when NODE_ENV !== 'production'             |
|  Player  |                                                     |
|  spike   |                                                     |
+----------+-----------------------------------------------------+
```

### Route map (no URLs removed)

| URL                           | Behavior after                                           |
| ----------------------------- | -------------------------------------------------------- |
| `/admin`                      | Overview (unchanged content, new shell)                  |
| `/admin/content`              | Inbox (canonical InboxView)                              |
| `/admin/stories`              | Renders `<InboxView preset={{ kind: "story" }} />`       |
| `/admin/articles`             | Renders `<InboxView preset={{ kind: "article" }} />`     |
| `/admin/articles/new`         | Unchanged. Reachable from Inbox "+ New article".         |
| `/admin/articles/import`      | Unchanged. Reachable from Inbox "Import from Sheets".    |
| `/admin/articles/[id]`        | Editor + new breadcrumb "← Inbox" (also keeps "Articles" |
|                               | label as a fallback for muscle memory).                  |
| `/admin/stories/[id]`         | Editor + new breadcrumb "← Inbox".                       |
| `/admin/videos/[id]`          | Unchanged (full-bleed, outside `(panel)`).               |
| `/admin/videos-spike/[id]`    | Returns 404 in prod via a NODE_ENV gate; still works locally. |
| `/admin/segments`             | Renamed in nav to "Intros & outros". Master switch       |
|                               | becomes an inline form on this page (in addition to its  |
|                               | existing home on Pipeline settings).                     |
| `/admin/templates`            | Renamed in nav to "Captions". URL unchanged.             |
| `/admin/models`               | Unchanged.                                               |
| `/admin/settings`             | Renamed in nav to "Pipeline". Fields regrouped into      |
|                               | named accordion sections.                                |

### Shell architecture

- `(panel)/layout.tsx` becomes a sidebar layout: a left `<AdminSidebar>` (client)
  for active-route highlighting and the mobile drawer toggle, a header with the
  brand + breadcrumb slot + user menu, and a `<main>` content slot.
- The `<AdminSidebar>` component reads `usePathname()` and lights the active
  item using prefix matching identical to today's `activePrefixes` pattern.
- A small `<Breadcrumb>` server component takes a `trail: { href, label }[]`
  prop and renders the chevron-separated breadcrumb. Inner editor pages render
  one explicitly (no auto-derive — explicit beats magic for routing).
- A new `<InboxView>` server component is extracted from
  `content/page.tsx`. It accepts an optional `preset` prop:
  `{ kind?: ContentSubKind | "story" | "article"; status?: string; language?: string; }`.
  When a preset is present, the chip for that dimension is hidden (the page is
  scoped) and the page title swaps to "Stories" / "Articles" / "Videos".
  `/admin/content`, `/admin/stories`, `/admin/articles` all delegate to it.

### Pipeline settings grouping

The `FIELDS` array in `/admin/settings/page.tsx` gains a `group` key. Groups
render as collapsible sections, default-open on first visit:

- **Pipeline** — `pipeline.subreddit`, `pipeline.limit`, `budget.daily_usd`
- **Voice** — `voice.google_voice_name`, `voice.google_style_prompt`,
  `voice.elevenlabs_voice_id`
- **Video look** — `video.style`, `media.scene_count`, `video.ken_burns`,
  `video.micro_wiggle`, `video.label_pop`, `video.scribble_draw`,
  `video.prop_slide`, `media.prop_count`, `video.mouth_swap`
- **Splice** — `video.intro_outro_enabled`

(Other future settings land in the right group rather than the bottom.)

### Spike gating

`videos-spike/[id]/page.tsx` short-circuits to `notFound()` when
`process.env.NODE_ENV === "production"`. Sidebar `DEV` section only renders for
the same condition.

## Phasing

Each phase is shippable on its own. Tests land in the same phase as the code
they cover (rule 18).

**Phase 1 — Sidebar shell**
1. Add `<AdminSidebar>` client component (active-state + drawer toggle).
2. Add `<Breadcrumb>` server component.
3. Rebuild `(panel)/layout.tsx` to use sidebar + header with page title slot
   and user menu.
4. Update Overview's "All stories" link to point at `/admin/content` (it
   currently points at `/admin/stories` — left over from the pre-unification
   nav).
5. Inner editor pages (`articles/[id]`, `stories/[id]`) get
   `<Breadcrumb trail={[{href:"/admin/content", label:"Inbox"}]} />` headers.

**Phase 2 — Inbox unification**
1. Extract `<InboxView>` from `content/page.tsx` (server component, accepts
   `preset` prop).
2. Rewrite `content/page.tsx` to delegate (no preset).
3. Rewrite `stories/page.tsx` to delegate with `preset={{ kind: "story" }}`.
4. Rewrite `articles/page.tsx` to delegate with `preset={{ kind: "article" }}`.
   The "imported" toast logic moves into `<InboxView>` behind an
   `articleImportFeedback?` prop.
5. Delete the now-duplicated `chip()` and `baseQs()` definitions from the
   two list pages (the dedup is the whole point).

**Phase 3 — Configuration polish**
1. `settings/page.tsx`: add `group` to each FIELD, render grouped accordions.
2. Page title and nav label flip from "Settings" to "Pipeline" (URL unchanged).
3. `segments/page.tsx`: surface the master switch inline (a `saveSettingAction`
   form bound to `video.intro_outro_enabled`). The existing "Edit in Settings"
   link stays as a fallback.
4. Nav label flips from "Templates" to "Captions". URL `/admin/templates`
   unchanged.

**Phase 4 — Spike gating + Videos sidebar**
1. Add `if (process.env.NODE_ENV === "production") notFound();` at the top of
   `videos-spike/[id]/page.tsx`.
2. Sidebar `CONTENT` → "Videos" links to `/admin/content?kind=video` (which is
   already a working filter on the inbox).
3. Sidebar `DEV` group renders only when `process.env.NODE_ENV !== "production"`
   and contains a "Player spike" entry pointing at the spike route. Server
   component reads `process.env`; no client leak.

**Phase 5 — Mobile drawer + Cmd-K stub**
1. Sidebar collapses to a hamburger drawer below `md` (Tailwind `md:` breakpoint).
2. A `Cmd-K` keybind opens an empty placeholder dialog ("Coming soon — file an
   issue if you'd use this"). Reserves the shortcut for later without committing
   to scope now.

**Phase 6 — QA pass**
1. Walk the lazy-user scenarios listed below in a real browser. Verify all
   golden paths, edge cases, and at least one regression-prone neighbor per
   change.
2. Run the full Vitest suite (per rule 18).

## Lazy-user walkthrough (rule 10)

Each of these must work without thinking:

- Lands on `/admin` → Overview with stats + Recent. Clicks "All stories" →
  lands on the unified Inbox (not a leftover legacy page).
- Wants to write a new article → sees Articles in the sidebar → clicks it →
  Inbox filtered to articles, with "+ New article" button top-right.
- Edits a story → clicks "← Inbox" in the breadcrumb → returns to Inbox with
  the previous filter intact (because URL state, not React state, drives
  filters).
- Wants to swap the active intro → Configuration → Intros & outros → toggles
  master switch inline (no detour to Pipeline) → picks new active segment.
- Wants to change the active voice model → Configuration → Models → sees the
  current model, the cost column, picks a new one, saves. The Models page does
  not change in this pass.
- Wants to tune the caption appearance → Configuration → Captions → same scope
  switcher as today.
- On mobile → taps hamburger → drawer slides in over the page → taps an item →
  drawer closes and the page navigates.
- Hits Cmd-K out of habit → sees the stub dialog. Doesn't break their flow.

## Security (rule 13)

- **Auth.** `requireAdmin()` is called in `(panel)/layout.tsx`. The reorganization
  does not change the auth model — every page under `(panel)` is admin-gated
  by the layout, plus each server action re-checks (defense in depth, unchanged).
- **Spike route.** Today the spike is `requireAdmin()`-gated, but it's still
  publicly reachable to any signed-in admin. After this change it returns 404
  in prod regardless of role. Defense in depth: `requireAdmin()` stays as the
  inner gate, the NODE_ENV check is the outer.
- **Master switch on `/admin/segments`.** The new inline form posts the same
  `saveSettingAction` already used by `/admin/settings` — same auth, same
  validation, same audit surface. No new attack vector.
- **No new logging of credentials or PII.** The observability logs below capture
  user IDs and route states, never tokens or emails-as-PII (emails are already
  printed in the header chrome — admin-only surface).
- **No new external calls.** Pure code reorganization. No new third-party
  packages, no new fetch destinations.
- **Settings flag dependency.** The `intro_outro_enabled` switch can now be
  toggled from two surfaces. Both write to the same `settings_kv` row; race is
  bounded to the last-write-wins behavior we already have.

## Observability (rule 14)

Namespaced `console.info` calls land in the new code:

- `[admin shell]` — layout render with `{ user_id, path, sidebar_collapsed }`.
- `[admin sidebar]` — sidebar item click with `{ from, to, group }`.
- `[admin inbox]` — InboxView render with `{ preset, filters, row_count }`.
- `[admin config]` — already covered by `saveSettingAction`; we add
  `[admin config splice]` when the master switch is toggled from the segments
  page so the source of truth is greppable.
- `[admin spike gate]` — fires once on server render of the spike route to
  confirm gate evaluation (`{ node_env, gated: true|false }`).

All logs emit actual values, not just "X happened" (per rule 14).

## Testing (rule 18)

Existing stack: Vitest (project uses it for component + lib tests). New tests
ship in the phase they cover.

- **Phase 1**: `AdminSidebar.test.tsx` — given a pathname, the correct item is
  active; `<Breadcrumb>` renders all trail entries.
- **Phase 2**: `InboxView.test.tsx` — preset hides the right chip group;
  preset is composed with URL search params (URL wins for overlapping keys, so
  a manual `?status=published` on `/admin/articles` works); empty state copy
  matches existing strings.
- **Phase 3**: `settings/page.test.tsx` — FIELDS produce the expected number of
  groups and every field lands in exactly one group; the segments-page master
  switch posts to `saveSettingAction` with `key=video.intro_outro_enabled`.
- **Phase 4**: `videos-spike.test.tsx` — `notFound()` is invoked when
  `process.env.NODE_ENV === "production"`; the sidebar DEV group does not
  appear in the rendered HTML when NODE_ENV is "production".
- **Phase 5**: smoke test for the mobile drawer toggle and the Cmd-K keybind
  registration.

Each phase ends with `npm run test` green before moving on.

## Settings audit (rule 15)

New persistent user choices introduced by this work:

| Setting                    | Where it lives             | Default       |
| -------------------------- | -------------------------- | ------------- |
| `ui.admin.sidebar_collapsed` | localStorage (client)    | `false`       |

That's the only one. The sidebar collapse state is per-browser; persisting it
server-side would couple a UI affordance to the user record for no payoff. No
new server-side settings.

Settings explicitly *not* introduced (and why):
- Sidebar item order: not customizable. Reordering nav items is a footgun — a
  user changing the order breaks their muscle memory and creates a support
  vector for "where did X go." Skip.
- Cmd-K behavior: nothing yet. Settings audit when the stub becomes a real
  command palette.

## Rejected alternatives

- **Option A (Tidy top nav).** Doesn't go far enough to feel "robust beautiful."
  Same chrome, less chaos. The deduplication and breadcrumb wins would land,
  but the navigation still has six sibling chips and no room to grow.
- **Option C (Single-inbox Studio with contextual right rail).** Too ambitious
  for the user's framing ("just unify"). The right-rail contextual panel is a
  separate feature, not a reorganization. Save for a later pass when there's a
  clear use case for it (e.g., quick-edit from the inbox).
- **Server-redirect `/admin/stories` and `/admin/articles` to `/admin/content`.**
  Tempting, but violates the no-removal constraint in spirit — every visitor
  ends up on a URL they didn't ask for, and any tool that 200-checks the legacy
  URLs starts seeing 302s.
- **Hard-delete the spike route.** The user explicitly said "don't remove
  anything." Gating is the right answer.
- **Move the intro/outro master switch *off* the Pipeline settings page.** Also
  feels like removal even though the value is still writable from the new
  surface. Keep both writable. Cost is one extra form on one page.

## Open questions

- **User menu surface.** The current header is just an email + sign-out button.
  This plan replaces it with a small user menu (avatar/initial → menu with
  email + sign out). Does the user want anything else in that menu now
  (account, theme toggle, etc.)? **Decision deferred** — ship menu with email
  + sign out, leave structure ready to add items.
- **Sidebar width.** Plan assumes 200px expanded, ~56px collapsed (icon-only).
  No bikeshedding — matches typical CMS conventions and looks fine in the
  existing token palette.
- **Cmd-K scope.** Stub only in this pass. Real command palette is a follow-up.

## File touch list

New files:
- `lorewire-app/src/app/admin/AdminSidebar.tsx`
- `lorewire-app/src/app/admin/Breadcrumb.tsx`
- `lorewire-app/src/app/admin/(panel)/_components/InboxView.tsx`
- Test files alongside each.

Modified:
- `lorewire-app/src/app/admin/(panel)/layout.tsx` — sidebar shell.
- `lorewire-app/src/app/admin/(panel)/page.tsx` — fix link to `/admin/content`.
- `lorewire-app/src/app/admin/(panel)/content/page.tsx` — delegate to InboxView.
- `lorewire-app/src/app/admin/(panel)/stories/page.tsx` — delegate to InboxView.
- `lorewire-app/src/app/admin/(panel)/articles/page.tsx` — delegate to InboxView.
- `lorewire-app/src/app/admin/(panel)/stories/[id]/page.tsx` — breadcrumb.
- `lorewire-app/src/app/admin/(panel)/articles/[id]/page.tsx` — breadcrumb.
- `lorewire-app/src/app/admin/(panel)/settings/page.tsx` — grouped accordions.
- `lorewire-app/src/app/admin/(panel)/segments/page.tsx` — inline master switch.
- `lorewire-app/src/app/admin/(panel)/videos-spike/[id]/page.tsx` — NODE_ENV gate.

Removed (file deletions only — no route deletions):
- `lorewire-app/src/app/admin/AdminNav.tsx` — superseded by AdminSidebar. (This
  is removing a file, not a feature. Every label and link it contained is
  preserved in AdminSidebar.)
