# 2026-06-24 — Unified Story + Short Editor

Status: **In progress** — Cut 1 (tab shell + Overview) shipped on `feat/unified-story-editor`.

## Goal

Collapse the three-screen drilldown (story detail → long-form video editor → shorts editor) into **one place** at `/admin/stories/[id]`. Every option present on any of the three screens stays reachable from that one URL. Long-form 16:9 editor remains accessible as an opt-in escape hatch for the rare case it's needed.

## Why

Today, editing a published short requires:
1. Land on `/admin/stories/[id]` from the inbox.
2. Click "Open video editor →" (bottom of the Media card in the right rail).
3. Land on `/admin/videos/[id]` — the **retired long-form editor**.
4. Click "Open editor →" inside `ShortRenderControl`.
5. Finally land on `/admin/shorts/[id]` — the editor we actually use.

Three screens, two forced clicks through a legacy surface we no longer create content for. Yoav called it "very bad ux" on 2026-06-24.

## Chosen approach (Option A)

Unify into a single page at `/admin/stories/[id]` with a tabbed center column and the existing right rail intact across all tabs.

### Tab structure (center column)

| Tab | Contents | Source today |
|-----|----------|--------------|
| **Overview** | Title, Category, Duration, Aspect Ratio, Source URL, Synopsis, Article body, Read-along script (`s.teleprompter` — the public reader's follow-along text, distinct from the short's narration script) | `stories/[id]/page.tsx` form |
| **Scenes** | Doodle frame grid, image prompt + alt text, per-frame regen, pin toggle, "Use in article" picker | `shorts/[id]/ScenesTab.tsx` |
| **Captions** | Per-chunk text + start/end ms editors | `shorts/[id]/CaptionsTab.tsx` |
| **Style** | Caption color, active-word color, outline, highlight mode, entry effect, y-position | `shorts/[id]/CaptionStyleTab.tsx` |
| **Script** | `ShortConfig.script` textarea — the narration the short's audio is generated from. **Distinct from the Read-along script** on Overview (which is the public reader's follow-along text). | `shorts/[id]/ScriptTab.tsx` |
| **Voice** | Both voice controls together: per-short override (`ShortConfig.voice_*`) at top, story-level default (`s.voice_id`) below, with the cascade explained inline. One place to think about voice. | `shorts/[id]/VoiceTab.tsx` + `VoicePicker` from story rail merged |
| **Publish & SEO** | SEO metadata card + 4 platform publish buttons (FB / IG / YT / TikTok) | `shorts/[id]/SeoMetadataCard.tsx` + `PublishTo*` |
| **Render** | Render status, Render-after-edits banner, Use-short-as-video, "Open 16:9 long-form editor →" escape hatch | `shorts/[id]/RenderStatusPanel` + new link |

Active tab is URL-driven (`?tab=scenes`) so deep links and back-button work and old `/admin/shorts/[id]` bookmarks can 308-redirect to `/admin/stories/[id]?tab=scenes`.

### Right rail (constant across tabs)

Unchanged from today's story detail page, with two adjustments:

- **Status** — kept
- **Engagement Poll** — kept
- **Search Visibility** — kept
- **Media Re-render** (Rebuild all media, Hero image regen) — kept
- ~~Voice (story-level default)~~ — **removed from rail**, merged into the Voice tab (one place for voice instead of two)
- **Intro / Outro segment overrides** — kept
- **Meta** — kept
- **Preview player** — moved from shorts-editor right sidebar into right rail; visible across all tabs (it's reference material, not tab-specific)
- **Edit-session banner** — moved up to a thin bar above the tabs so it's visible regardless of tab

### Escape hatch: long-form 16:9 editor

`/admin/videos/[id]` route stays alive, fully functional. Reachable via one discoverable link in the **Render** tab:

> ⚙ Open 16:9 long-form editor → (legacy, opt-in)

with a one-line caption: "For the retired long-form pipeline. New stories should not need this." No other admin surface links to it.

### Link migration map

| Today | Tomorrow |
|-------|----------|
| `/admin/stories/[id]` "Open video editor →" button | Removed — page IS the editor now |
| Admin dashboard "Recent" row → `/admin/videos/[id]` | → `/admin/stories/[id]` |
| `/admin/videos` list page rows → `/admin/videos/[id]` | → `/admin/stories/[id]` |
| Shorts editor backlink "← Story" → `/admin/videos/[id]` | n/a (route 308-redirects) |
| Shorts editor "no short yet" fallback → `/admin/videos/[id]` | n/a (route 308-redirects) |
| `/admin/shorts/[id]` direct URL (old bookmarks) | 308-redirect to `/admin/stories/[id]?tab=scenes` |

### What's deleted

Nothing user-facing is deleted. Long-form-only features that have **no shorts equivalent and never will** (motion beats specific to long-form pipeline, 16:9-canvas overlays, aspect picker, trim window for long audio, Remotion 16:9 preview composition) stay where they are — inside the still-alive `/admin/videos/[id]` route, reachable via the escape hatch. They are not migrated to the unified page because they don't apply to shorts.

## Alternatives rejected

- **Option B (minimal: just kill the middle screen)** — fixes navigation but leaves story metadata and short editing as two screens. Doesn't satisfy "one place for all."
- **Option C (move metadata into shorts editor; story page becomes redirect)** — same end state as A but inverts the canonical URL. Rejected because every other admin surface (inbox, dashboard, lists) already thinks in terms of stories, not shorts.
- **Single mega-page (no tabs, just scroll)** — every control visible on one ~4000px page. Violates rule 16 (clean, intuitive). Rejected.

## Resolved (decided 2026-06-24 chat)

1. **Read-along script — kept on Overview, no "(legacy)" label.** It's a real user-facing feature (the public reader's follow-along text). Distinct from the short's narration script.
2. **Voice — one place, in the Voice tab.** Per-short override on top, story-level default below, cascade explained inline. Voice card removed from the right rail.
3. **Default landing tab from inbox — Overview.** (Old `/admin/shorts/[id]` bookmarks still 308 to `?tab=scenes`.)
4. **Escape hatch — Render tab.**

## Security (rule 13)

- All existing `requireCapability("content.manage")` gates are preserved. The unified page reuses the same server-side auth check on the story shell — no new endpoint surface.
- No new secrets. No new external services.
- The 308 redirect from `/admin/shorts/[id]` is a server-side redirect, not a client-side one — no token-in-URL risk.
- Edit-session heartbeat moves up to the page level (was per-editor). Same DB-backed session row, same foreign-session takeover flow — no semantic change, just a UI move.

## Observability (rule 14)

Per rule 14: every meaningful step gets a namespaced log on first wiring.

- `[unified editor tab]` — tab change events: `{ storyId, fromTab, toTab }`
- `[unified editor mount]` — initial render: `{ storyId, activeTab }`
- `[unified editor redirect]` — when `/admin/shorts/[id]` or `/admin/videos/[id]` (dashboard links) redirect into the unified page: `{ fromPath, toPath, storyId }`
- `[unified editor escape hatch]` — when user clicks "Open 16:9 long-form editor": `{ storyId, currentTab }`

## Settings (rule 15)

Audit per rule 15: are any defaults the user should be able to flip?

- **Default landing tab from inbox** — likely yes. Add a per-user setting under Settings → Workflow: "Default story page tab" (Overview / Scenes / Render). Default: Overview.
- **Preview player always-visible** — yes. Some users may want the right rail compact. Add: "Show preview player in right rail" (boolean, default on).
- Everything else is data-driven (status, poll content, etc.) and doesn't need a settings knob.

## Testing (rule 18)

- **Unit:** `tabs.test.ts` covers the URL resolver (6 cases: missing, empty, unknown, non-string, array, every known id). Future cuts add tests for any new server-action wrappers.
- **Integration:** smoke-test that each tab mounts without crashing when given a story with (a) no short_config, (b) a fully populated short_config, (c) a story in each status (in_review / ready / published).
- **Regression:** existing tests (`homepage-rails.test.ts`, etc.) must stay green — no DB schema changes, no public-route changes.
- **Manual QA pass per rule 6:** golden path (inbox → click story → land on Overview → switch through every tab → edit something on each → save → reload → see persisted), edge cases (story with no short rendered yet, story with foreign edit session, story with no scenes, story with empty poll), error paths (server action fails, auth expires mid-edit), and the escape-hatch round trip (open long-form editor, edit, return).

## Deploy (rule 19)

- **Branch:** `feat/unified-story-editor`, branched off the current production-source `feat/multi-platform-shorts-publisher` (per AGENTS.md: production is in the inverted state, tracking a feature branch instead of main).
- **PR target:** `feat/multi-platform-shorts-publisher` (NOT main — merging anything to main while it's behind production = takedown #4 per the 2026-06-22/23 incident log).
- **Vercel-UI safety:** once Vercel builds a preview from this branch, **do not click "Promote to Production"** on it — that bypasses Environments → Production tracking and would force-build this WIP branch as production. The PR landing into `feat/multi-platform-shorts-publisher` is what triggers the auto-deploy.
- **Rollback:** revert the PR commit on `feat/multi-platform-shorts-publisher` → Vercel auto-redeploys the previous production state. Long-form route stays alive throughout, so even a partial failure doesn't take down editing — users fall back to the escape hatch URL.

## Sequencing

- **Cut 1 (shipped):** tab shell + URL resolver + Overview tab, with the other 7 tabs rendering a placeholder card that points at `/admin/shorts/[id]` while the port lands.
- **Cut 2:** port Scenes / Captions / Style / Script / Voice (the 5 ShortConfig-driven tabs — they share client state, so they ship together).
- **Cut 3:** port Publish & SEO + Render, add the 16:9 escape hatch link.
- **Cut 4:** 308 redirects for `/admin/shorts/[id]`, update dashboard + videos-list link targets, remove the "Open video editor →" button from the right-rail Media card.

## Out of scope

- Touching `/admin/videos/[id]`'s editor surface beyond confirming it still works in isolation.
- Renaming or restructuring the `/admin/videos` list page (the "Stories" list with a misleading name). Tracked as a follow-up.
- Any new per-scene UX. This is a consolidation, not a feature pass.
