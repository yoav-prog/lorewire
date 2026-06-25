# User settings page (+ Stories settings group)

Date: 2026-06-25
Status: in flight
Predecessors:
  - PR #79 — v1 Stories rail/viewer
  - PR #80 — Stories slug + Read full
  - PR #83 — Stories gestures, ring-fade, desktop removal
  - PR #82 — Stories desktop layout (now superseded by removal)

## Goal

Two outcomes in one PR:

1. **A user-facing Settings page at `/settings`.** Anonymous-friendly
   (works without login), works on mobile + desktop, mirrors the
   `mx-auto max-w-xl px-6 py-10` shell pattern from `/auth/account`.
2. **A Stories settings group inside it** — the v2 item 2 follow-up
   to PR #79. Plus exposes the existing Wires prefs that today only
   live in localStorage with no UI to control them.

## Why this matters

- Several user prefs exist but have no UI: `useWirePrefs.autoplay`,
  `useWirePrefs.muted`, `useWirePrefs.advance`. Users get the
  defaults forever because there's nowhere to flip them.
- Stories has new prefs that need a home: auto-advance on/off,
  auto-advance dwell for image-only wires.
- Per rule 15 of CLAUDE.md, every feature gets a Settings audit.
  Stories shipped without one because no settings page existed.
  This PR creates that surface so future features have a home for
  their toggles without having to build the layer themselves.

## Sections (v1)

### Playback

- **Autoplay wires** — toggle. Wraps `useWirePrefs.autoplay`.
- **Start wires muted** — toggle. Wraps `useWirePrefs.muted`. Also
  applies to Stories (one mute pref across the product).
- **End-of-wire behavior** — segmented choice (Advance / Loop).
  Wraps `useWirePrefs.advance`.
- **Auto-advance stories** — toggle. NEW pref
  (`lw.stories.autoadvance.v1`, default true). When off, the viewer
  never advances on its own; users tap / swipe.
- **Auto-advance duration (image stories)** — segmented choice
  (4s / 6s / 8s / 10s). NEW pref
  (`lw.stories.image_dwell_ms.v1`, default 6000). Only affects
  image / text-only wires; video wires always advance on `ended`.

### Privacy & data

- **Reset viewed stories** — destructive button. Clears
  `lw.viewed_wires.v1` (uses existing `useViewedWires().clearViewed`).
  Confirm dialog before firing.

### Out of scope (v1)

- Resetting Saved / Liked / Continue / Ratings / Recently-viewed —
  the buttons all exist behind hooks but the user didn't ask for
  them; defer to a follow-up "more reset controls" PR if needed.
- Theme toggle (light/dark) — `ThemeProvider` + `useTheme` exist
  but the system theme handling is fine for v1; explicit toggle
  is a separate plan.
- Account section — `/auth/account` already exists for that.
  Settings cross-links to it when the user is signed in.

## Routes + layout

- `src/app/settings/page.tsx` — server component shell. No session
  redirect (anonymous-first); checks session only to decide whether
  to show the "Account" cross-link.
- `src/app/settings/SettingsClient.tsx` — client component holding
  all the toggles + reset buttons. Reads from existing pref hooks
  + the two new Stories pref hooks.
- Layout: `mx-auto max-w-xl px-6 py-10` matching `/auth/account`.
  Back-to-home link at the top, h1 "Settings", subtitle, then
  sections as cards.

## New pref stores

`src/components/stories/use-stories-prefs.ts`:

- `useStoriesAutoAdvance()` — boolean store, key
  `lw.stories.autoadvance.v1`, default `true`. Same `BoolStore`
  pattern as `useWirePrefs.ts` (consent-gated; in-memory still
  flips so the UI is responsive without persistence).
- `useStoriesImageDwellMs()` — number store, key
  `lw.stories.image_dwell_ms.v1`, default `6000`. Choices clamped
  to {4000, 6000, 8000, 10000}; values outside the closed set
  reset to the default.

Tests in `use-stories-prefs.test.ts` cover happy path + consent
gate + clamp behavior.

## Wire prefs into viewer

`StoriesViewer.tsx`:

- Replace `DEFAULT_IMAGE_DWELL_MS = 6000` reads with
  `useStoriesImageDwellMs()`. The current `setActiveDurationMs` on
  video metadata-loaded stays (video duration wins for video wires).
- Auto-advance timer effect: when `!autoAdvance`, skip the timer
  entirely (same shape as the existing `reducedMotion` check).
- Mark-viewed logic unchanged — it fires on `complete` or
  `dwell-advance`, both of which still occur (manual advance from
  user tap/key/swipe is dwell-advance with dwell ≥ 2s).

## Navigation entry

- **Desktop (`DesktopShell.tsx` TopNav)** — small gear icon button
  next to the SignInChip in the top-right. Plain `<a href="/settings">`.
- **Mobile (`AppShell.tsx` MobileShell)** — small gear icon in the
  MyList tab header (top-right of the My List screen). Avoids
  crowding the bottom tab bar with a 6th item. Also accessible from
  the homepage via the top-right of the home header (TBD on
  implementation if simpler).

## Security (rule 13)

- All settings are local-storage backed; no server endpoints.
- Reset buttons are destructive (clear localStorage) — confirm
  dialog gates them.
- No PII. No new external services.
- Cookie consent gate already in place via the underlying pref
  stores; settings page doesn't bypass it.

## Observability (rule 14)

- `[settings page mount]` — `{ has_session }`
- `[settings change]` — `{ key, from, to }` on every toggle / value
  change
- `[settings reset]` — `{ what: "viewed_stories", count_cleared }`
  on each reset button

## Testing (rule 18)

- `use-stories-prefs.test.ts` — new boolean store tests, new number
  store tests (clamp/coerce/persist/consent-gate).
- Settings page is mostly stateless UI consuming hooks; no
  component-level test (no @testing-library set up). Manual QA on
  the Vercel preview covers visual + interaction.

## Deploy (rule 19)

- Branch: `feat/user-settings-page` off
  `origin/feat/multi-platform-shorts-publisher` (worktree).
- PR target: `feat/multi-platform-shorts-publisher` (production
  source, inverted-state rules).
- **Do not click "Promote to Production" / "Redeploy" / "Rebuild"**
  on the preview.

## Cost (rule 8)

Zero. Pure client-side, no third-party services, no AI calls, no
new infra.

## What this PR does NOT touch

- `/auth/account` — separate surface, stays as-is.
- Wires feed code — only reads the existing `useWirePrefs`; no
  behavior change.
- AppShell mobile shell — adds a small gear icon entry point but
  no structural changes.
