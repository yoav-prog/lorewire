# Contributor profiles + gamification

Date: 2026-06-29
Status: approved, building
Branch base: `feat/multi-platform-shorts-publisher` (the prod branch)

## Goal

Give signed-in users a public **contributor profile** with a rank, a badge, a
progress bar, and their contribution counts (submissions, comments, votes). User
stories get a "Submitted by [name]" byline that links to the submitter's profile.
Comment author names link to the same profile. Ranks are visible to everyone via
the profile (no global leaderboard). This rewards participation and gives a
submitter a personal identity on the site.

## Decisions (confirmed with Yoav 2026-06-29)

1. **Votes count, going forward.** Start attributing signed-in users' votes to
   their account at vote time. Past anonymous votes are not backfilled (they can't
   be — they're cookie-only). Votes are weighted low so rank can't be farmed by
   voting. Logged-out voting stays fully anonymous and unchanged.
2. **Profile badge, no leaderboard.** Rank + badge + counts live on each user's
   own profile, linked from their stories and comments. No site-wide ranked list
   (avoids a farm-the-top race).
3. **Limited public view, with opt-out.** Profile shows display name, avatar,
   rank/badge, contribution counts, and "member since". Never shows email or which
   way anyone voted. A per-user setting hides the profile (privacy by default-on,
   opt-out to hide).

## Scoring + ranks

Points are a weighted sum, computed live (cheap COUNT queries, all indexed on
user_id). Weights make a published submission dominate and a vote negligible:

- published submission: 25
- published comment: 5
- vote (distinct poll): 1

Only post-moderation activity counts (published comments, approved/published
submissions) so spam in the queue earns nothing.

Rank tiers (lore-themed, deliberately not generic "bronze/silver/gold"):

| Tier | Name        | Points |
|------|-------------|--------|
| 1    | Newcomer    | 0      |
| 2    | Contributor | 10     |
| 3    | Storyteller | 50     |
| 4    | Chronicler  | 150    |
| 5    | Loremaster  | 400    |
| 6    | Legend      | 1000   |

Progress bar = progress from the current tier's floor toward the next tier's floor.

## Architecture

Two phases, two PRs (the vote change is isolated because it touches the live,
idempotency-critical voting path).

### Phase A — vote attribution (PR 1)

The schema was already designed for this: `poll_votes.user_id` (nullable), the
partial unique index `idx_poll_votes_poll_user` (poll_id, user_id) WHERE user_id
IS NOT NULL, and `reconcileVotesForCookieToken` (backfills a browser's anon votes
at sign-in). The gap: `recordVote` never set `user_id`, so votes cast after login
weren't attributed until the next login re-ran reconciliation.

- `lib/polls.ts` `recordVote`: add `userId?: string | null` to `RecordVoteInput`;
  INSERT `user_id`; extend idempotency so an existing (poll_id, user_id) row is an
  idempotent no-op too (pre-check + the catch-block race re-read), matching the
  unique index. One vote per signed-in user per poll across all their browsers —
  exactly what the index intends.
- `app/api/polls/vote/route.ts`: read the optional active session
  (`readActiveUserSession`, suspended-aware → null) and pass `userId`.
- Extend `lib/polls.test.ts`: signed-in vote sets user_id; same user, second
  browser = no-op; anonymous vote still inserts with user_id NULL.

### Phase B — profiles + gamification (PR 2)

- `lib/contributor-rank.ts` (pure, client-safe): tier table, `POINT_WEIGHTS`,
  `pointsFor(stats)`, `rankForPoints(points)` → { tier, name, next, floor,
  nextAt, progress }. Unit-tested.
- `lib/contributions.ts` (server-only): `getContributionStats(userId)` → the three
  COUNT queries + points. `getPublicProfile(userId)` → user + stats + rank, or null
  if hidden/missing.
- `schema.ts`: additive `users.profile_hidden INTEGER` (NULL/0 = public).
- `app/u/[id]/page.tsx`: public profile (opaque UUID URL — users have no handle).
  notFound() when missing or hidden. Avatar, name, rank badge, progress bar,
  counts, member since.
- `components/ContributorBadge.tsx` (or inline): the rank badge, reused on the
  profile and the user's own dashboard.
- Byline on stories: `app/v/[slug]/page.tsx` submission footer gets "Submitted by
  [display_name]" linking to /u/[userId]. Needs `submission_id` in the public
  story read (`stories-public.ts` PUBLIC_COLS) + a helper
  `getSubmissionAttribution(storyId)` → { userId, displayName }.
- Comment author names link to /u/[userId] when `author_user_id` is set
  (`CommentsSection.tsx`).
- Self dashboard: a stats/rank card on `/submissions` (and/or the account page).
- Opt-out toggle on the account page → server action sets `profile_hidden`.

## Security / privacy (rule 13)

- Profile is a **limited view**: only name, avatar, rank, counts, member-since.
  Never email, never per-vote choices, never queue/draft submissions (only
  published contributions are counted/shown).
- Opt-out: `profile_hidden` hides the page (404) and the byline/comment links fall
  back to plain text.
- Suspended users: profile 404s (don't surface suspended accounts publicly).
- Vote attribution does not change what's shown about votes publicly beyond a
  count; the direction of a vote is never exposed.
- Anti-gaming: low vote weight + count only distinct polls + only post-moderation
  comments/submissions.

## Rejected alternatives

- **Full leaderboard** — more gamified but invites farming and a public ranked
  list of users is a bigger privacy surface. Rejected in favor of profile-only ranks.
- **Private-only gamification** — safe but doesn't meet "for everyone to see".
- **Leave votes out of the score** — simplest, but the user wants votes counted.

## Open questions

- Backfill: should we run reconciliation-style attribution for very recent votes,
  or strictly count from ship? (Decision: strictly from ship; simpler + honest.)
- Avatar fallback for users with no picture_url (initial-based monogram).
