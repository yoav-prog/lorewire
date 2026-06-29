# Wires rename, real-player behavior, and counted likes

Date: 2026-06-22
Branch: feat/r2-media-migration (working tree already carries unrelated in-flight work)

## Goal

Three connected changes to the short-video feed:

1. Rename the feature from "Reels" (Meta's trademark) to **Wires** (leans into the LoreWire brand: dispatches coming in over the wire). DONE before this plan was written; see the rename section for what moved.
2. Make the feed behave like a real short-video player: scrub, seek, pause on interaction, autoplay with a persistent off switch, plus the small touches that make it feel native.
3. Make likes **actually counted server-side and displayed**, replacing the local-only heart.

## Constraints

- This is NOT stock Next.js (see AGENTS.md). Portable SQL only, dual driver (Postgres / node:sqlite) through `all/one/run` in `lib/db.ts`, `?` placeholders.
- No new paid services. Likes use the existing DB (`user_likes` table already exists, indexed, GDPR-wired). Cost impact: one indexed COUNT subquery per feed page plus two tiny batch reads. Negligible at current scale.
- Respect the existing consent model: anonymous identity (`lw_anon`) is only issued on consent-accept; local stores skip persistence without consent.

## Decisions (locked with the user)

- **Like-count display: show only past a threshold.** Counts are recorded server-side from day one, but the number is hidden until a wire reaches `LIKE_COUNT_THRESHOLD` (3) likes; below that only the heart shows. This avoids the "dead 0 likes" look on a zero-traffic catalog while staying honest. The threshold is a one-line constant we drop to 0 once traffic justifies it.
- **End of video: loop.** Matches how Instagram Reels / TikTok actually behave; the user swipes to move on.

### Why a threshold and not raw counts (the honest flag)

The catalog has no public traffic. Showing real counts now means almost every wire reads "0" or "1", which signals "nobody is here" and undercuts perceived quality. The codebase already reflects a prior LLM-council decision to avoid fabricated/empty social counts (rating-store comments, `_plans/2026-06-22-ratings-and-share.md`). The threshold is the compromise: real data, recorded from the start, surfaced only once it means something.

## Rename (done)

- `src/components/reels/` -> `src/components/wires/` (git mv, history preserved).
- `ReelCard -> WireCard`, `ReelsFeed -> WiresFeed`, `ReelsDesktop -> WiresDesktop`, `useReelsData -> useWiresData`, `useLikedReels -> useLikedWires`, `ReelsI -> WiresI`, `reelsStoryId -> wiresStoryId`, `openReels -> openWires`.
- User-facing nav label "Reels" -> "Wires"; empty/loading copy; aria-labels.
- Preserved (these are Meta's actual product or an idiom, not our feature): privacy page "publish Reels and posts", `TikTok / Reels` referral mentions, publishing-target hints in the admin, "highlight reel" idiom, the historical `feat/reels-feed` branch name, and the `_plans/2026-06-17-reels-vertical-video-feed.md` path.

## Player behavior (the build)

All in `WireCard` (shared by mobile `WiresFeed` and desktop `WiresDesktop`):

- **Scrubber**: a progress bar above the control bar; shows played fraction; draggable to seek (pointer events); current/total time on hover/seek.
- **Tap / click**: toggles play/pause immediately (snappy).
- **Double-tap / double-click**: likes the wire with a heart-burst animation. Two quick play-toggles net to no change, so no revert gymnastics.
- **Press and hold**: pauses while held, resumes on release (the TikTok feel).
- **Hover (desktop)**: reveals the scrubber + time, then auto-hides.
- **Autoplay master toggle**: a pinned control next to mute. Default on. When off, a wire shows its poster + a center play button and waits for a tap. Persisted (consent-gated) via `useWirePrefs`, shared with the mute preference.
- **Buffering spinner** on stall (`waiting` -> on, `playing`/`canplay` -> off).
- **Keyboard (desktop)**: space = play/pause, left/right = seek 5s (up/down already page between wires).
- Loop stays on; reduced-motion still suppresses autoplay and requires an explicit start.

## Likes (the build)

- **`user_likes`** already has `(id, user_id, story_id, created_at)` + unique `(user_id, story_id)`. Add `idx_user_likes_story` on `story_id` so the count-by-story query is indexed.
- **`toggleLikeStory(storyId, liked)`** server action:
  - Validates the story is real + public (no arbitrary rows).
  - Identity: signed-in user id, else the consented `lw_anon` token (issued here on first like when consent is accepted). No consent -> no DB write, no cookie; returns the current public count so the client keeps a local optimistic heart without moving the number.
  - Idempotent set to the target state: `INSERT ... ON CONFLICT (user_id, story_id) DO NOTHING` to like, `DELETE` to unlike. Returns `{ ok, liked, count, persisted }`.
- **Feed read**: extend `listPublishedShorts` to attach `like_count` and `viewer_liked` per row via two small batch queries (`COUNT ... GROUP BY` and a viewer membership check) over the page's ids. New `WireStory = LiveCatalogStory & { like_count; viewer_liked }`.
- **Client**: `useWireLikes` holds per-story `{ liked, count }`, seeded from server rows, optimistic toggle + server reconcile + revert on error. `WireCard` shows the heart from this state and the count only when `count >= LIKE_COUNT_THRESHOLD`.

## Security (rule 13)

- One like per (viewer, story) enforced by the DB unique index -> no count inflation by repeat taps; the action sets a target state idempotently.
- No persistence and no identity cookie without consent (anonymous) or a real session (signed-in).
- Story id validated against the public gate before any write; all SQL parameterized.
- No new PII: the like row carries only the user/anon id already covered by GDPR export (`personal-data.ts`) and account deletion (`account-deletion.ts`).

## Alternatives rejected

- **Always show counts / show 0**: rejected as the default per the zero-traffic flag above; available as a one-line threshold change.
- **Correlated subqueries inside the main feed query**: rejected for the batch-query approach to avoid fragile `?`->`$n` reordering and keep the existing query readable.
- **Auto-advance on end**: rejected; loop is the authentic reels behavior and the user chose it.

## QA

- `tsc --noEmit` clean for changed files; `vitest run` green.
- Add a unit test for the like batch-attach / threshold boundary where practical.
- Manual: scrub, hold-to-pause, double-tap-like, autoplay off persists across reload, like count appears only at the threshold, consent-off keeps likes local.

## Open questions

- Threshold value (3) is a guess; trivial to tune.
- Whether to surface the autoplay toggle's state with a label or icon-only (icon + tiny label chosen for the lazy-user clarity bar).
