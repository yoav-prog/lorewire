# Slow mode for video playback

## Goals

Older viewers told the team the wires feel too fast — the story moves
quickly, captions flash by, and the comprehension load is high for
anyone not already used to vertical short-form video. The fix is a
**Slow mode** toggle that drops video playback to a calmer pace
(0.75x) while keeping voice intelligible. Same content, accessible to
more people, no per-story authoring change required.

The bar (rule 10): a user who finds the videos too fast should be able
to fix it in one tap from the player, or in two taps from anywhere
else in the app. No menus to dig through. No speed picker to fiddle
with. The choice persists across sessions and applies to every video
they watch from then on.

## Constraints

- **No new infra.** Slow mode is a client-side `playbackRate` change
  on the existing `<video>` element. No re-encoding, no per-story
  field, no migration.
- **Anonymous-first persistence.** Setting lives in `localStorage`
  behind the existing consent gate, matching how the other wire prefs
  work (autoplay, muted, advance — all gated by the `lw_consent`
  cookie). No backend write, no account required.
- **Audio quality must hold.** A `<video>` element at 0.75x without
  `preservesPitch` sounds drugged. The element must set
  `preservesPitch = true` explicitly before adjusting rate, on every
  surface that uses it. Safari historically supported `webkitPreservesPitch`
  too — set both for safety.
- **Two surfaces only (for now).** Wires (`WireCard`) and Stories
  (`StoriesViewer`). The poll panel, the share sheet, and the image-
  dwell timer for image stories are out of scope.
- **No new copy in Hebrew.** The app's UI is English-only at this
  layer (verified against `SettingsClient.tsx`); we keep it that way.

## Requirements

1. A single boolean preference: `slowMode` (default `false`).
2. Persists in `localStorage` under `lw.wires.slow.v1`, gated by
   `lw_consent`, using the existing `createBoolStore` factory in
   `useWirePrefs.ts` (no new pattern, no parallel store).
3. When `slowMode === true`:
   - All `<video>` elements in the Wires feed play at `0.75x` with
     pitch preservation.
   - All `<video>` elements in the Stories viewer play at `0.75x`
     with pitch preservation.
   - When the user flips the toggle mid-playback, the rate updates
     immediately on the live element (don't wait for the next load).
4. Player chrome (Wires): a fifth control next to autoplay / advance /
   mute showing a small "0.75x" badge when slow mode is on, neutral
   when off. Tap toggles. Joins the existing auto-hide chrome group.
5. Settings page: a new `ToggleRow` in the Playback section above the
   "When a wire ends" segmented row, labelled "Slow mode" with a
   description that explains the speed and the reason ("Play videos
   at 0.75× speed for an easier, calmer pace.").

## Chosen approach

**Extend `useWirePrefs.ts` with a fourth bool store (`slow`) following
the exact pattern that already exists for `autoplay` / `muted` /
`advance`.** This keeps everything that touches wires playback in one
file and gives the Stories viewer a stable hook to import from. No
new file, no new abstraction, no parallel preference system.

Then wire it through two surfaces:

1. **`WireCard.tsx`** — read `slow` via `useWirePrefs` in the parent
   `WiresFeed` (where the other prefs are already read), pass it down
   as a `slow: boolean` prop alongside `muted`/`autoplay`/`advance`.
   Inside `WireCard`, mirror it onto the `<video>` element in an
   effect that sets `playbackRate = slow ? 0.75 : 1` and
   `preservesPitch = true` whenever `slow` changes. Add a fifth
   chrome button next to the existing mute/advance/autoplay row.
2. **`StoriesViewer.tsx`** — read `slow` directly via `useWirePrefs`
   (no prop drilling — there's no shared parent reading the others).
   Apply the same effect to its `<video>` element.

The toggle handler in both the chrome button and the Settings row
calls `setSlow` from the same store, so flipping it anywhere updates
both surfaces and the chrome icon at the same time.

Default value: `false`. The fast default is intentional — most
viewers prefer the default pace; slow mode is opt-in for the
audience that needs it.

## Alternatives rejected

1. **Per-story `slow_mode_default` field on the database.**
   Lets editorial mark certain stories as "play this one slowly."
   Rejected because the problem isn't story-specific; it's
   viewer-specific. Older viewers want every video slowed, not
   editorial picks. Adding a field would shift work to editorial
   for zero viewer benefit.

2. **Speed picker (0.5x / 0.75x / 1.0x / 1.25x).**
   YouTube-style segmented control. Rejected because both Amit and
   the manager explicitly pushed against it in the chat
   ("שאנחנו בלי להציע מלא אפשרויות"). Three choices is still
   choice fatigue for a feature whose target user is "person who
   doesn't want to think about playback speed."

3. **0.5x as the slow rate (Amit's literal suggestion).**
   Half speed sounds underwater even with pitch preservation. The
   accessibility benefit is overwhelmed by the audio quality drop;
   we'd ship "slow but unpleasant," which nobody flips on twice.
   0.75x preserves intelligibility and still feels visibly calmer.

4. **Server-side re-render at a slower speed.**
   Render a second video at 0.75x per story. Massive cost
   (doubles render time, doubles storage), zero benefit over a
   client-side `playbackRate` change. Pure overengineering.

5. **A "comfort mode" umbrella that bundles slow playback +
   bigger text + reduced motion.**
   Tempting but premature. We have one signal (videos feel fast),
   we ship the one fix. If two more comfort requests land, then
   we group them under a named mode.

## Security & safety

This is a client-side display preference. There is no PII, no
auth surface, no input from the network. The risk surface:

- **localStorage value tampering.** A user could set
  `lw.wires.slow.v1` to garbage. The store reads with `raw === "1"`,
  defaulting to `false` on anything else — already safe by pattern.
- **playbackRate values that misbehave.** Browsers clamp rates to
  sane ranges (most cap at 0.0625–16.0). We only ever set 0.75 or
  1.0 — hardcoded constants, not user input — so there's no
  injection vector.
- **Consent gate.** Persistence respects `lw_consent`. A user who
  declined cookies sees the toggle work in-session but it doesn't
  hit disk. Matches the existing wires prefs behavior; no new
  consent decision required.

Nothing here changes the network surface, the auth surface, or what
gets logged server-side.

## Observability

Per rule 14, every meaningful step gets a tagged console log:

- `[wires prefs slow]` from inside `setSlow` when the value flips,
  with `{ from, to }`. Mirrors the existing `[settings change]`
  log shape so a diagnostic walk picks it up the same way.
- `[wires playback rate]` in the `WireCard` effect that mirrors
  the rate onto the `<video>`, logging
  `{ id, rate, preservesPitch }` whenever the rate is set. This
  is the line we grep when a user reports "I turned slow mode on
  and the video still plays fast."
- `[stories playback rate]` — same shape from `StoriesViewer`.
- `[settings change]` (existing handler) picks up the Settings
  page toggle automatically since we route through `settingsLog`.

No backend logging — there's no backend call.

## Settings audit (rule 15)

- **Surfaced**: `slowMode` boolean in the Playback section. Goes
  above "When a wire ends" so the order reads autoplay → muted →
  slow → end-of-wire behavior → stories prefs. Default `false`.
- **Intentionally NOT surfaced**:
  - The actual numeric speed (0.75). Hardcoded. A speed picker is
    the thing the whole feature was designed to avoid.
  - Per-surface scope (wires vs. stories). One toggle, both
    surfaces. If a viewer wants slow video, they want it
    consistently.
  - The pitch preservation flag. Always on. Off would sound
    broken — there's no use case for exposing it.

## Testing (rule 18)

The wires prefs store already has the shape; we extend its tests.
A new component test confirms the chrome toggle round-trips.

- **`useWirePrefs.test.ts`** (extend if it exists; create if not):
  - Default value is `false`.
  - `setSlow(true)` followed by `setSlow(false)` round-trips
    through localStorage when consent is accepted.
  - With consent declined, the in-memory value flips but
    localStorage stays empty.
  - The `slow` value participates in `useSyncExternalStore`'s
    subscribe/snapshot contract (a second hook caller sees the
    new value after `setSlow`).
- **`WireCard.test.tsx`** (extend):
  - Renders the slow-mode chrome button.
  - Clicking it calls the `onToggleSlow` prop.
  - When `slow={true}` is passed, the effect sets the mocked
    `<video>` element's `playbackRate` to `0.75` and
    `preservesPitch` to `true`. When `slow={false}`, sets `1.0`.
- **`StoriesViewer` test** (extend the existing test file if there
  is one; otherwise this is the one surface we'll flag as
  "covered by manual QA" with a note in the plan, per the rule's
  honesty clause).
- **Manual QA pass before calling it done** (rule 6):
  - Toggle from player chrome → playback slows immediately on the
    current video.
  - Toggle from Settings page → next-loaded video plays slow;
    current video also updates immediately.
  - Refresh page → slow mode persists.
  - Decline cookies, toggle → works in session, doesn't persist.
  - Audio at 0.75x: voice still intelligible, no obvious pitch
    artifacts. Test on at least one wire and one story.
  - Mobile Safari + desktop Chrome + desktop Firefox.

## Deploy (rule 19)

- **Branch**: stay on the current `feat/asset-gate-trust-short-render`
  branch is wrong — this is unrelated work. Cut a fresh branch
  `feat/slow-mode-playback` off the production-source branch
  (whatever Vercel currently tracks — verify before branching, per
  AGENTS.md), so the work doesn't entangle with the asset-gate
  diff.
- **PR target**: PR into `main`. Do NOT manually promote the
  preview build to production from the Vercel UI. Auto-promotion
  via main-merge only — per AGENTS.md "Never manually promote a
  non-production-source build."
- **Verify before push** (per the saved memory and AGENTS.md):
  `git fetch origin && git log HEAD..origin/main --oneline` —
  must be empty before pushing.
- **Rollback**: revert the merge commit. The change is fully
  client-side; no migration to undo, no data shape to roll back.
  A revert returns playback to 1.0x with no residual state
  (existing users will still have `lw.wires.slow.v1` set in
  localStorage but the missing code path means it's a no-op).

## Open questions

1. **StoriesViewer test coverage.** Is there an existing test file
   for `StoriesViewer.tsx`? If yes, we extend it. If not, this is
   the one place where the rule 18 "untestable" exception might
   apply (it's tightly coupled to the gesture / timer system) —
   I'll flag it in the implementation rather than block on it.
2. **Chrome button visual.** The plan calls for a "0.75x" badge
   when on, neutral when off. Alternative: a single rabbit/turtle
   glyph that flips. The badge is more literal and removes any
   ambiguity about what state the toggle is in; happy to spike
   both during implementation and pick the cleaner one.
