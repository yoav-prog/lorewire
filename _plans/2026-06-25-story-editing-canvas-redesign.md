# 2026-06-25 — Story editing canvas redesign (cut 7)

Status: **Approved** (2026-06-25 chat)

## Problem

After cut 6, the Scenes tab still squeezed scene cards into 3 narrow columns. Three video surfaces competed (DONE thumbnail, Live Preview, right-rail Media card). RENDER LANE banner and DONE panel duplicated the Action Bar's "Last rendered Xh ago" + Re-render button. Rail kept eating 320px on tabs where the user was editing, not managing.

## Approach

Make editing tabs (Scenes / Captions / Style / Script / Voice) a **full-width canvas**. Keep the rail on metadata/decision tabs (Overview / Publish & SEO / Render) where it adds context. Strip the redundant banners. Toggle the preview from the Action Bar.

### Per-tab layout

| Tab | Layout |
|-----|--------|
| Overview | Tab content + StoryRail (320px) — unchanged |
| **Scenes / Captions / Style / Script / Voice** | **Full-width tab content + optional 360px Live Preview (toggleable)** |
| Publish & SEO | Tab content + StoryRail (320px) — unchanged |
| Render | Tab content + StoryRail (320px) — unchanged; ALSO gains the RenderAfterEditsBanner + RenderStatusPanel that used to render above the editing tabs |

### What disappears

- **Right rail on editing tabs** — reclaims 320px. Granular scenes regen moves INLINE below the scene grid (only place it was rail-rendered for editing tabs).
- **RenderAfterEditsBanner + RenderStatusPanel above editing tabs** — moves into RenderTabContent only. Action Bar shows status + Re-render trigger; if you want the lane-plan detail + lane history, switch to Render tab.
- **Right-rail Media card** (rendered MP4 preview) on editing tabs — duplicates the Live Preview. Removed from those rails.
- **"RENDER LANE: No changes" status bar + DONE panel** — both duplicated the Action Bar. Removed.

### What's new

- **Action Bar gains a "👁 Preview" toggle chip** — only visible on editing tabs. Toggles ShortPreviewPlayer inline visibility. State persisted in `localStorage` so it survives navigation.
- **Granular scene regen inline on Scenes tab** — below the scene grid, only on Scenes (the natural home for it).

## Files

| Action | File |
|--------|------|
| Add `isEditingTab` + `isRailTab` predicates + test | `tabs.ts`, `tabs.test.ts` |
| New `useShortPreviewVisibility` localStorage hook | `useShortPreviewVisibility.ts` |
| Add `activeTab` prop + Preview toggle chip | `StoryActionBar.tsx` |
| Move RenderAfterEditsBanner + RenderStatusPanel from shared chrome into RenderTabContent only; conditionally render ShortPreviewPlayer; inline GranularRegenGrid on Scenes | `StoryShortTabsClient.tsx` |
| Conditionally skip rail entirely on editing tabs; pass activeTab to ActionBar; pass sceneGranular to StoryShortTabsClient | `page.tsx` |

## Boundary safety

Every change keeps Server Components as server, Client Components as client. The new `useShortPreviewVisibility` hook is "use client" — only imported by client components.

## Test plan

- [ ] Open story → Scenes tab → no rail visible → scene grid expands to 4-5 columns of wider cards
- [ ] Click "👁 Preview" chip → preview hides → main column becomes 100% width
- [ ] Reload → preview state remembered
- [ ] Action Bar still shows "Last rendered Xh ago" + working Re-render
- [ ] Granular scene regen still works — now lives below the scene grid on Scenes tab
- [ ] Switch to Render tab → rail comes back, RenderAfterEditsBanner + RenderStatusPanel show inline
- [ ] Switch to Overview / Publish → rail unchanged

## Deploy

Same inverted-state rules as cuts 1-6. PR targets `feat/multi-platform-shorts-publisher`.
