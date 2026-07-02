# Wires: fullscreen exit UX (manager-reported)

Date: 2026-07-02
Branch: `fix/wires-fullscreen-exit-ux`, off `main` @ 943ad5d.

## The report

Amit (manager, 2026-07-02): on the site, Wires accidentally switches to
fullscreen, then there is no visible way out, so he wanted "a way back to the
state where you can vote."

## Diagnosis

The exit paths all work (X button, Escape, `fullscreenchange` handling in
`WiresFeed` / `WiresDesktop`). The failure is discoverability plus one real
placement trap:

1. **Accidental entry.** The enter-fullscreen button floats bottom-right,
   36px above the scrubber, inside the auto-hide chrome group. Tap the video
   to pause and the button fades in under your thumb; the next tap lands on
   it. `WireCard.tsx` ~line 957.
2. **Invisible exit.** The exit control is a bare X circle, visually identical
   to the mute and options circles next to it. Nothing says "this is the way
   out."
3. **Voting feels gone.** In immersive mode the poll panel is replaced by a
   small pill at top-left; he never found it.

## Fix (all client UI, `WireCard` + a CSS keyframe + logs in the two feeds)

1. **Move the enter button into the top-right control cluster** (before mute):
   `[fullscreen] [mute] [more]`. Nobody scrubs or taps there by accident. The
   floating bottom-right button is deleted.
2. **Exit becomes a labeled pill**: X icon + "Exit" in the card's mono
   uppercase type, hairline border so it reads as a control (same treatment as
   the poll pill). Stays pinned visible (immersive pins chrome). On entering
   immersive it plays a one-shot triple ping ring (~2.4s) so the eye lands on
   the way out first. Skipped under `prefers-reduced-motion`.
3. **Voting moves to the thumb zone**: in immersive, the poll pill relocates
   from top-left to the bottom-left stack, directly above the title, where
   TikTok-style UIs put content actions. Pill stays out of the auto-hide
   group (always visible). Tapping it opens the existing poll bottom sheet.
   Exiting fullscreen also returns to the normal card with the full poll
   panel, which is literally the manager's ask.

## Alternatives rejected

- **Auto-open the poll sheet on entry** — covers the video, punishes users
  who entered fullscreen to watch.
- **Drop real fullscreen for a CSS overlay** — would keep browser chrome
  visible (its own exit affordance) but loses the actual immersive value and
  the native-snap-scroll rationale from the 2026-07-01 plan. Not needed once
  exit is obvious.
- **Text toast "swipe up for next, tap Exit to leave"** — copy nobody reads;
  the ping on the labeled pill points at the control itself.

## Security

No new inputs, storage, or network. Pure presentation over the existing
user-gesture-gated Fullscreen API.

## Observability

- `[wires immersive enter]` / `[wires immersive exit]` (info, with
  `{ via: "button" }`) in `WiresFeed` + `WiresDesktop`.
- `[wires immersive dropped]` (info) when Escape / the OS gesture ends
  fullscreen via `fullscreenchange`.
- Existing `[wires immersive enter err]` warns stay.

## Settings

No new setting. Fullscreen is a transient view mode, not a preference — a
"disable fullscreen button" toggle would be a knob nobody asks for once entry
is no longer accidental. Reduced-motion users get the ping suppressed via the
existing `reducedMotion` prop rather than a setting.

## Testing

`WireCard.test.tsx` (vitest + happy-dom, existing harness):
- enter button renders inside the top-right cluster (shares a parent with
  mute) and still invokes `onEnterImmersive`.
- exit pill carries the "Exit" label and invokes `onExitImmersive`
  (existing test, extended).
- immersive + poll: the vote pill renders in the bottom-left stack with the
  title; tapping it opens the poll sheet (panel's answer buttons appear).
- entry ping renders when `reducedMotion` is false, not when true.

Out of scope: real Fullscreen API behavior (jsdom has none — the feed's
enter/exit/`fullscreenchange` wiring is unchanged by this fix) and visual
regression of the ping animation.

## Deploy

Standard flow: push branch → PR → review → merge to main → Vercel deploys
production from main. No env changes. Rollback = revert the PR.
