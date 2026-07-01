# Live vote updates + Wires "unvoted by default"

Date: 2026-07-01
Branch: `feat/live-vote-updates` (worktree `C:/Projects/lorewire-votes`, cut fresh from `origin/main`)

## Goal

Two related user asks:

1. **Votes should update the UI without a refresh.** Today, voting on a
   story leaves it sitting in the homepage "You Didn't Vote Yet" rail
   until a full page reload. "Every similar action should be the same" —
   any vote-gated surface should react the instant you vote, the way
   likes and saves already do.
2. **Wires should default to only the videos you haven't voted on,** with
   a visible toggle to switch back to all videos.

## Why the rail is stale today

The "You Didn't Vote Yet" rail (the `continue` surface) filters through
`filterIdsByNotVoted(ids, votedSet)`. `votedSet` is built once from
`initial.votedStoryIds`, computed server-side at request time
(`homepage-data.ts` → `loadVotedStoryIds` → `listVotedStoryIdsByCookie`,
keyed by the vote cookie). It is a static prop threaded into
`DesktopShell` / `AppShell` and never changes after mount. `PollWidget`
updates only its own local state on a vote, so the shell's `votedSet`
stays stale until a reload re-runs the server query.

Likes/saves already update live because they go through the reactive
`engagement-store` (useSyncExternalStore). Votes are the missing store.

## Decisions (confirmed with the user)

- **Fresh worktree off `origin/main`** — the `feat/imprint-legal-gdpr`
  tree has an unresolved stash-pop conflict (unrelated GDPR WIP) and is
  left untouched.
- **Wires filter is server-side** — a new `onlyUnvoted` param on
  `listPublishedShorts` so pagination stays healthy when most wires are
  voted (a pure client filter can starve the feed).
- **A wire you just voted on stays put** (shows its result), and drops
  out on the next feed load / toggle — no jarring mid-scroll removal.

## Part A — reactive "voted stories" (Ask 1)

New module `src/lib/voted-stories.ts`: a minimal in-memory reactive
mark-once store (useSyncExternalStore, same idiom as engagement-store's
mark-once store) — **NOT** persisted to localStorage and **not**
consent-gated, because the server already persists every vote by cookie
and re-seeds `votedStoryIds` on each load. This store is only an
optimistic *same-session overlay* of votes cast in this session. Exports:

- `useVotedStories()` → `{ voted, hasVoted }`
- `markVotedStory(id)` — write-only, callable from the vote widgets

Wiring:

- `DesktopShell` / `AppShell`: union the SSR seed with the session store —
  `votedSet = useMemo(() => new Set([...votedStoryIds, ...sessionVoted]), …)`.
  When a vote is marked, `sessionVoted` changes → `votedSet` recomputes →
  the continue rail drops the story immediately.
- `PollWidget.castVote` (homepage DetailModal — both shells pass
  `storyId`): call `markVotedStory(storyId)` on a successful vote.
- `WirePollPanel.castVote` (Wires — always has `storyId`): same.

The homepage rail and the Wires filter both read the SAME truth (cookie
votes), so behavior is consistent across surfaces.

## Part B — Wires unvoted-by-default + toggle (Ask 2)

- `useWirePrefs`: add `hideVoted` bool store (default **true**), key
  `lw.wires.hide_voted.v1`, consent-gated persistence like the other
  prefs. Expose `hideVoted` + `toggleHideVoted`.
- `listPublishedShorts` (`actions.ts`): add `onlyUnvoted?: boolean` to
  `ListShortsOpts`. When true, read the vote token, get
  `listVotedStoryIdsByCookie`, and add `AND id NOT IN (…)` to the SQL
  WHERE (before the cursor clause so params stay in lockstep). Empty
  voted list / no cookie → no filter (shows all, which is correct).
- `useWiresData(pageSize, onlyUnvoted)`: thread the param into the first
  page + `loadMore`; reset feed state when `onlyUnvoted` flips so the
  toggle refetches from scratch.
- `WiresFeed`: read `hideVoted` / `toggleHideVoted`; pass
  `onlyUnvoted={hideVoted}` to `useWiresData`; render a feed-level,
  top-center segmented pill ("Unvoted | All", IG/TikTok-style) so the
  filter is discoverable and switchable; on toggle, clear any shuffle
  order and scroll back to top. Distinct empty state when `hideVoted` and
  0 results: "You've voted on every wire" + a "Show all wires" button
  (rule 10 — a lazy user must never hit a dead end).

## Security / safety

- No new data stored client-side (Part A is in-memory only; Part B pref
  is a boolean UI setting behind the existing consent gate).
- Server filter reuses the existing cookie-attributed vote read; no new
  attack surface, no PII logged.
- `onlyUnvoted` defaults off in `ListShortsOpts` so no other caller
  changes behavior; only the Wires feed opts in.

## QA plan (rule 6)

- Unit: `voted-stories` store (mark/has/subscribe/dedupe); `useWirePrefs`
  `hideVoted` default + toggle.
- Full `vitest run`, `tsc --noEmit`, `eslint`.
- Manual golden path: vote in homepage modal → thumbnail leaves the
  "You Didn't Vote Yet" rail without refresh; Wires opens filtered to
  unvoted; vote on a wire → it stays with its result; toggle "All" →
  full feed; toggle back → just-voted wire is gone; vote-on-everything →
  caught-up empty state with working Show-all.

## Rejected alternatives

- **Re-fetch `votedStoryIds` after each vote** — extra round trip, slower,
  more plumbing than an in-memory overlay.
- **`router.refresh()` / revalidate on vote** — re-runs the whole SSR
  payload, visible flicker, heavy for a one-id change.
- **Client-side Wires filter** — simplest, avoids the server change, but
  can starve the paged feed to near-empty when most wires are voted.
