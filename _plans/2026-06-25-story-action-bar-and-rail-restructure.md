# 2026-06-25 — Story Page Action Bar + Rail Restructure

Status: **Approved** (Option B picked via AskUserQuestion 2026-06-25)

## Goal

Two problems on `/admin/stories/[id]` after the cut-1-to-4 consolidation:

1. **Right rail is a 4000px scroll** — 14 panels stacked vertically (Status, Poll, Search visibility, Media re-render, Hero style, Comments, World Bible, Granular scenes, Granular props, Voice picker, Media preview, Intro override, Outro override, Meta).
2. **Render controls are stranded** — Generate / Re-render / Restart live behind the Render tab + the legacy long-form editor. Someone on Overview can't see "is a render in progress?" or kick a new one off without tab-hopping.

This plan fixes both with two coordinated cuts.

## Chosen approach (Option B from AskUserQuestion)

### Cut 5: Top Action Bar
A sticky horizontal bar above the tabs, visible on every tab:

```
┌──────────────────────────────────────────────────────────────────┐
│ [● IN REVIEW ▾] [▶ Re-render] [⚡ Generate] [⟲ Restart] [⋯ More] │
│ Last rendered 2h ago · idle                                       │
└──────────────────────────────────────────────────────────────────┘
```

- **Status pill** — replaces the rail `Status` card. Click → dropdown with In Review / Ready / Published + Archive. Reuses the existing `setStoryStatus` action.
- **Render state line** — live polling indicator: idle / queued / "Drawing scenes 32%" / done / error. Reuses `latestShortRenderAction` + `getShortRenderStatusAction` polling pattern from `ShortRenderControl`.
- **▶ Re-render** — queues a new render with current `short_config` edits applied. Reuses the lane-plan logic from `RenderAfterEditsBanner` (Lane A/B/C decided server-side).
- **⚡ Generate** — opens a popover with vibe picker + length preset, then `queueShortRender`. For stories without a short yet, this is the primary CTA.
- **⟲ Restart** — confirm dialog → `restartShortRenderAction` (clears `short_config`, queues fresh render). Destructive — the confirm step is non-negotiable.
- **⋯ More** — overflow menu for the less-frequent global actions: Archive, Hide from search, Toggle comments. (These currently live in rail cards.)

The bar is one cohesive client component (`StoryActionBar.tsx`) that owns its own polling + popovers. Loads its initial state from the page's already-fetched render row (when a short tab is active) or a small dedicated fetch (when on Overview).

### Cut 6: Per-Tab Rail + Advanced Drawer
- **Per-tab rail content**: 3-5 cards max per tab.
  - **Overview** → Engagement Poll, Hero Style, Meta
  - **Scenes / Captions / Style / Script / Voice** → Media preview (already there via `ShortPreviewPlayer`), Per-asset regen, Hero Style
  - **Publish & SEO** → Status awareness, Meta
  - **Render** → Full Media Re-render panel, Granular scene regen, Granular props regen, Intro/Outro segments, World Bible
- **Advanced drawer** at the bottom of every rail (collapsed by default). Holds the rare-use cards that don't naturally belong to any one tab: Search visibility, Comments toggle, Intro/Outro segments (when not on Render tab), World Bible.
- **Voice picker removed from rail** — already in the Voice tab. Carryover from Cut 3 plan that was deferred.
- **Status card removed from rail** — now in the Action Bar.
- **Media card preserved** (hero image / gallery / audio / video preview) — visible on Overview and Render tabs.

## Cut sequencing

| Cut | What | Why first/second |
|-----|------|------------------|
| **5** | Top Action Bar | Standalone value. Surfaces the missing render controls AND makes status changes one-click on every tab. Doesn't touch the rail, so it's safe to ship even if Cut 6 stalls. |
| **6** | Per-tab rail + Advanced drawer | Solves the scroll. Depends on Cut 5 (Status card moves into the bar so it can disappear from the rail). |

Both target `feat/multi-platform-shorts-publisher` per the inverted-state rules in AGENTS.md.

## Security (rule 13)
- All actions reuse existing `requireCapability("content.manage")`-gated server actions. No new endpoint surface.
- Restart has a confirm dialog because it's destructive (clears `short_config`).
- No new secrets, no external services.

## Observability (rule 14)
- `[action bar render]` — initial mount, with `{ storyId, hasActiveRender, currentStatus }`
- `[action bar action]` — every button click, with `{ storyId, action: "re-render" | "generate" | "restart" | "status-change" | "archive" | …, currentStatus }`
- `[action bar poll]` — render-status poll cycles (debug-level, only when render is in progress)

## Settings (rule 15)
- **Default behavior of Re-render**: should it ask for confirmation when changes are small (Lane A only)? Probably no — Re-render is a low-cost gesture. Skip the confirm.
- **Restart confirmation copy**: hardcoded for now ("This clears all edits and re-renders from scratch. Continue?"). Could be a user setting later if it becomes annoying. Out of scope for Cut 5.

## Testing (rule 18)
- Unit: a small reducer/dispatcher inside `StoryActionBar` for tracking poll state. Test the state transitions.
- Manual QA: every button on every tab, with stories in each render state (no short / queued / rendering / done / error).
- Regression: existing tabs/tests stay green.

## Deploy (rule 19)
- Branch: `feat/unified-story-editor-cut-5-action-bar` (Cut 5), `feat/unified-story-editor-cut-6-rail` (Cut 6).
- PR target: `feat/multi-platform-shorts-publisher` (NOT main) — same inverted-state rules as cuts 1-4.
- Vercel: no manual "Promote to Production" clicks on previews — merge into production-source is the only deploy trigger.

## Out of scope

- Removing the standalone `/admin/shorts/[id]` route (deliberately kept alive in narrowed Cut 4).
- Touching the long-form `/admin/videos/[id]` editor (it remains the escape hatch from the Render tab).
- Changing what Generate / Re-render / Restart actually DO at the action layer — only surfacing them in a new place.
