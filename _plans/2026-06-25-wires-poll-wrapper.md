# Wires-feed poll wrapper (Alternative C — hybrid pill + panel)

**Date:** 2026-06-25
**Branch:** `fix/asshortclienttab-server-boundary` (will branch off into
`feat/wires-poll-wrapper` before any code lands)
**Origin:** Yoav's manager asked for a "wrapper" containing the question +
answer options on each wire. We weighed three layouts; the user picked
Alternative C.

## Goal

Every wire in the Wires feed (one card = one full-frame 9:16 short) gets
a thumb-friendly poll surface that is **beautiful, intuitive, clean,
colorful**, and reveals **percentages after voting** without dragging the
user out of the feed.

The user already approved the direction (Alternative C — hybrid). This
plan executes it.

## What ships in this PR

### Visual: Alternative C — hybrid

Two co-operating surfaces per card:

1. **Floating VOTE pill on the video** (top-right area, above the video
   chrome row). Small, dark-glass, "POLL · vote" copy with a pulsing red
   dot. Does NOT cover the artwork.
   - **Post-vote state:** morphs into ambient social proof:
     `73% AGREE` (the bigger-side %), no pulse, neutral chip.
   - Tapping it (pre-vote) scrolls / smooth-focuses the panel below.
2. **WirePollPanel below the video**, inside the control bar where
   "READ THE STORY" + Like/Save/Share live today. The panel IS the
   wrapper the manager asked for: dark surface, thin amber→blue
   gradient accent strip on the left, big question, two thumb-zone
   answer buttons in side-by-side layout.
   - **Pre-vote:** "What do you think?" kicker + 2 large buttons
     (amber A, electric blue B) with the option labels.
   - **Post-vote:** buttons morph in place into 2 horizontal % bars
     filling left-to-right with `transition-[width] 700ms ease-out`,
     big `XX%` numbers on each side, vote count below, user's pick
     gets a soft ring + `YOU` chip. Verdict kicker:
     `You're with the majority` / `It's a close call` /
     `You're in the minority` (reuse PollWidget verdict logic).
   - **No floor yet:** percentages stay hidden until the public floor
     is reached (existing `polls.public_floor` setting governs this —
     do not bypass).

### Color choice

- Option A → **Amber `#F59E0B`** (already a sibling of the brand red,
  reads as "team A")
- Option B → **Electric Blue `#3B82F6`** ("team B")
- User's pick after vote → keep the option color, add a soft ring in
  the same hue and a small `YOU` chip in the brand `accent` red so the
  poll still feels like Lorewire.

Why not just brand red? "Smart Pushback / Too Far" is not right vs
wrong. Two distinct neutral hues read as opinions, not judgment. Red
stays as the brand owner of the YOU chip + the pill's pulsing dot.

### Layout adjustments to WireCard

The control bar today is one horizontal row (title + Read CTA on the
left, Like/Save/Share on the right). We insert a 2nd row above this
row containing the poll panel — and only when the wire has a live
poll. The title row stays where it is. The control bar grows ~110 px
when a poll is present; when it isn't, layout is unchanged.

The **floating pill** sits inside the existing top chrome row of the
video stage, on the LEFT side (the right side already has 4
controls — autoplay / advance / shuffle / mute). Pulses for 6 seconds
after the wire activates, then settles to steady.

## Data wiring

The current `WireStory` doesn't carry poll data. Add it.

### Type changes — `polls-shared.ts`

New shared type so both server and client can speak it:

```ts
export interface WirePollData {
  pollId: string;
  question: string;
  optionA: string;
  optionB: string;
  /** Server-rendered result so first paint matches reality. Null when
   *  there are zero votes (panel renders pre-vote state). */
  initialResult: PollResultView | null;
  /** Which side this viewer's cookie has already chosen, if any. */
  initialVotedSide: PollSide | null;
}
```

### Server batch helper — `lib/polls.ts`

`listPublishedShorts` returns up to 50 stories. We need their polls
batched, not N+1. Three new helpers:

```ts
getPollsByStoryIds(ids: string[]): Promise<Map<storyId, PollRow>>
getAggregatesByStoryIds(ids: string[]): Promise<Map<storyId, PollAggregateRow>>
getVoteSidesForCookie(pollIds: string[], cookieToken: string | null):
  Promise<Map<pollId, PollSide>>
```

Then a top-level `getWirePollsForStories(storyIds, cookieToken,
publicFloor)` that composes the three reads and returns
`Map<storyId, WirePollData>`. One round trip per helper (three trips
total) instead of N per story.

### Action change — `app/actions.ts`

- Extend `WireStory` with `poll: WirePollData | null`.
- `listPublishedShorts` calls `getWirePollsForStories` after
  `attachLikeState`. Cookie token comes from `readVoteToken()`
  (same as `/v/[slug]`).
- Stories without a live poll get `poll: null`. The panel + pill stay
  hidden for those rows — no empty wrapper.

### Vote submission

Reuse `/api/polls/vote` unchanged. Already has:

- Origin check
- Rate limit (10/min, 100/hour per IP+UA hash)
- Cookie idempotency
- Returns `PollResultView` so the post-vote bars paint immediately.

## Components

### New files

- `src/components/wires/WirePollPanel.tsx` — the panel
- `src/components/wires/WirePollPill.tsx` — the floating pill
- `src/components/wires/WirePollPanel.test.tsx` — state-machine tests

### Modified files

- `src/components/wires/WireCard.tsx` — slot the panel into the
  control bar, slot the pill into the video chrome row.
- `src/app/actions.ts` — `WireStory.poll`, populate via batch helper.
- `src/lib/polls.ts` — batch helpers above.
- `src/lib/polls-shared.ts` — `WirePollData` type.

### State machine (WirePollPanel)

Mirrors PollWidget. The shared rules:

- `votedSide = null` AND `totalVotes < floor` → pre-vote, kicker
  "Be one of the first."
- `votedSide = null` AND `totalVotes >= floor` → pre-vote, kicker
  "Pick a side to reveal the split."
- `votedSide != null` → post-vote bars, verdict kicker (only when
  hasFloor), `YOU` chip on the user's pick.
- Vote action: optimistic — paint post-vote immediately, fetch in a
  transition, revert on error with a small inline error banner.

## Settings audit (rule 15)

Walked Settings → Playback (the existing Wires prefs surface) and
decided **no new toggles ship with this PR**. Reasoning:

- `polls.public_floor` (admin) already controls when % reveal — reuse.
- An end-user "Show poll prompt on shorts" toggle is tempting but:
  - The /v/[slug] reader and the article reader don't expose a poll
    toggle; adding one only on wires is inconsistent.
  - Polls are a core engagement surface, not chrome — hiding the
    primary action of the feature would defeat the point.
  - Wires already has 3 prefs (autoplay / muted / advance). Adding a
    fourth for a high-value surface dilutes the panel.
- Pill position, option colors, animation toggle: all deliberately
  hardcoded. Color palette is part of the feature's identity (rule 5
  — designs must feel deliberate); a per-user palette knob would
  invite "looks AI-generated" complaints.

If the team later wants to A/B "panel only" vs "panel + pill", that's
an admin-side experiment behind `settings.polls.wires_pill_enabled`,
not an end-user preference. Out of scope for this PR.

## Observability (rule 14)

Namespaced logs, matching existing `[wires …]` / `[polls …]` style:

- `[wires poll panel mount]` — `{ storyId, pollId, hasVoted, hasFloor }`
- `[wires poll vote start]` — `{ pollId, side }`
- `[wires poll vote result]` — `{ pollId, inserted, pctA, pctB,
  totalVotes }`
- `[wires poll vote error]` — `{ pollId, status, body_error }`
- `[wires poll vote network-error]` — `{ pollId, err }`
- `[wires poll pill click]` — `{ pollId, state: "vote" | "results" }`
- `[wires poll panel batch resolve]` (server) — `{ requested,
  with_poll, with_aggregate, with_vote }`

No secrets, no PII. Cookie prefix only (first 8 chars) like the
existing vote-recording log.

## Security (rule 13)

- Vote endpoint is unchanged → origin + rate-limit + idempotency
  guarantees inherited.
- Batch poll resolution runs on the server in `listPublishedShorts`
  (a server action). Cookie token is read server-side and never sent
  to the client; the client only sees `initialVotedSide`.
- The pill and panel never log option text, only IDs and counts.
- No new attack surface.

## Testing (rule 18)

### Unit (Vitest)

- `WirePollPanel.test.tsx` — pre-vote (no votes), pre-vote (below
  floor with some votes), pre-vote (above floor), optimistic
  post-vote, error revert. Mock the fetch.
- `WirePollPill.test.tsx` — initial pulse, post-vote ambient %,
  click handler fires.
- `polls.test.ts` (extend) — batch helpers return correct shape on
  empty input, mixed-poll input, missing-aggregate rows.

### Manual

- Vote on a wire with no prior vote → bars animate, pill morphs.
- Refresh page → post-vote state persists (cookie roundtrip).
- Vote on the same poll from /v/[slug], return to wires → post-vote
  state matches.
- Story without a poll → no panel, no pill, layout unchanged.
- Story with poll but `total_votes < floor` → no % shown after vote,
  microcopy explains.

## Deploy (rule 19)

- All work on a NEW branch off this branch:
  `feat/wires-poll-wrapper`.
- PR targets `main`. PR description includes:
  - Plan link
  - Before/after screenshots of a wire with + without a poll
  - The "do NOT promote in Vercel UI" reminder per AGENTS.md
- **Do NOT push directly to main, do NOT promote a non-production
  branch in Vercel UI** (AGENTS.md hard rules).
- Before push: `git fetch origin && git log HEAD..origin/main
  --oneline`. If non-empty, bring main into the branch first.

## Out of scope (explicit)

- Personalized prediction ("most people in your category picked …")
- Animated transition between the pill on the video and the panel
  below (one-shot pulse only)
- Refactoring the existing PollWidget used in /v/[slug] and the
  article reader — that stays exactly as-is.
- A new admin "poll attached to a wire" CRUD surface — admins use the
  existing PollEditor.
