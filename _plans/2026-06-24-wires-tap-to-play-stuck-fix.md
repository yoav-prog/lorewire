# Wires: fix the intermittent "tap to play" stuck state

Date: 2026-06-24
Branch: feat/facebook-auto-publish (the active working branch; this fix is
small enough to ride along, but if we want a clean PR I'll move it to its
own branch — flagged below).

## What the manager reported

Amit messaged about Wires: "sometimes after a few videos (not consistent),
[a wire] doesn't auto-play and everything is in a tap-to-play state."

Symptom: while swiping through the vertical shorts feed, a card occasionally
shows the big centre Play overlay instead of autoplaying. It's intermittent
and happens after a few swipes. Tapping the button starts the video, so the
video itself is fine — the player is just stuck thinking the browser blocked
autoplay.

## Root cause

`WireCard.tsx` had a Promise race-prone `tryPlay()` that treated any
`play()` rejection as a real autoplay-policy block:

```ts
// WireCard.tsx (before)
const p = v.play();
if (p && typeof p.then === "function") {
  p.then(() => setBlocked(false)).catch((e) => {
    setBlocked(true);  // every rejection = blocked
    console.warn("[wires play blocked]", { id: short.id, e: String(e) });
  });
}
```

When the user swipes from short B to C before B's `play()` Promise resolves,
B's shouldPlay effect runs `v.pause()`. The browser rejects B's pending
`play()` Promise with `AbortError` ("The play() request was interrupted by
a call to pause()"). That rejection is a benign race — NOT an autoplay
policy block — but the catch handler sticks `blocked = true` on B.

Three things together made it stick:

1. `showPlayButton = active && !paused && ((!autoStart && !userStarted) || userPaused || blocked)` — `blocked` is sufficient to render the overlay on an active card.
2. The render-time reset only cleared `blocked` when a card transitioned **active → inactive**. Re-entering active did NOT clear it.
3. Stale catch handlers from old `play()` calls could fire AFTER a fresh `tryPlay()` had resolved, overwriting `setBlocked(false)` with `setBlocked(true)` via microtask ordering on quick flicks.

Net result: race-condition-dependent intermittent stuck Play overlay. Maps
exactly to the manager's report.

## Goals

- Centre Play overlay only appears when (a) autoplay is genuinely off / reduced motion is on (opt-in mode), (b) the user explicitly paused, or (c) the browser actually blocked autoplay with `NotAllowedError`.
- Swiping fast between shorts never strands a card in `blocked=true`.
- No behavioural change for the legitimate autoplay-blocked case (real `NotAllowedError`) — the user can still tap to play.

## Constraints

- React 19 + Next 16 App Router. Single file change, no new dependencies.
- Player markup unchanged (no visual regression on golden path).
- Logging keeps the `[wires ...]` namespace per rule 14.

## Approach (one option; alternatives below for the record)

Three surgical changes in `WireCard.tsx`:

1. **Distinguish error types in `tryPlay`'s catch.** Only set `blocked = true` for `NotAllowedError` (real autoplay-policy block). `AbortError` is logged at info level and ignored. Anything else is logged but not treated as a hard block.
2. **Add a `playGenRef` generation counter.** Bump it on every `tryPlay` call AND on every `v.pause()` in the shouldPlay effect's else branch. The then/catch handlers check `gen === playGenRef.current` before applying state — stale Promise results from invalidated calls become no-ops.
3. **Reset `blocked` and `userPaused` when a card becomes active**, not just when it becomes inactive. Belt-and-braces against any other path that could leave them stuck.

### Alternatives considered

- **Cancel via AbortController on the play() Promise.** `HTMLMediaElement.play()` does not accept an AbortSignal. Rejected.
- **Drop the `blocked` flag entirely and rely on the browser's own paused/playing state.** Possible but loses the ability to surface a real autoplay block clearly. Rejected.
- **Wrap `tryPlay` in a 200ms debounce so quick flicks don't kick off doomed play() calls.** Adds latency on the happy path and doesn't actually fix the underlying race (just shrinks the window). Rejected.

Recommendation: option 1. Small, surgical, addresses the actual cause.

## Tests (per rule 18)

`WireCard.test.tsx` (happy-dom, vitest 4) covers:

1. **Race regression test:** mock `HTMLMediaElement.prototype.play` to return a controllable Promise. Render WireCard active=true, then switch to active=false (pause fires), reject the pending play with AbortError, switch back to active=true. Asserts: no Play overlay button is rendered (i.e., `blocked` did not stick).
2. **Real autoplay block still surfaces the overlay:** reject the play Promise with `NotAllowedError`. Asserts: Play overlay button IS rendered on the active card.
3. **Happy path:** play() resolves cleanly. Asserts: no Play overlay.
4. **Microtask-ordering test:** stale tryPlay's catch fires AFTER fresh tryPlay's then resolves. Asserts: no Play overlay (gen counter guard works).

This is the first test file under `src/components/wires/`.

## Observability (per rule 14)

Logs become more useful:
- `[wires play blocked]` warn — kept, but only fires for `NotAllowedError`. Now includes the `name` field.
- `[wires play interrupted]` info — `AbortError` from pause-during-play race. Diagnostic, not a problem.

## Security / safety (per rule 13)

None. Pure client-side state-machine fix. No data, no auth, no inputs.

## Settings (per rule 15)

No new settings. Autoplay master toggle already exists.

## UI / UX (per rule 16)

Improvement only: removes a stuck-state where a perfectly good video showed
a tap-to-play overlay it shouldn't. The "real block" case (NotAllowedError)
keeps the same overlay, same wording, same affordance.

## Cost (per rule 8)

Zero. No infra change.

## Branch question for Yoav

This branch (`feat/facebook-auto-publish`) is unrelated. Strictly, this fix
should land on its own branch. Calling it out so we choose deliberately —
will ask before pushing/PRing.

## Open questions

- None for the fix itself. Branch placement is the only call to make before
  PRing.
