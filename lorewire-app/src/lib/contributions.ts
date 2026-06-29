// Contributor contribution counts + public profile reads. server-only: the
// scoring/rank MATH is client-safe in lib/contributor-rank.ts; this module is the
// DB half. Counts are computed live from three indexed COUNTs (cheap enough on a
// profile view, no projection table to keep fresh).
//
// Only PUBLIC, post-moderation activity counts, so nothing in a moderation queue
// or draft earns points:
//   - submissions: only those that became a live, published story (joined to
//     stories.status, so the count is right even before the dashboard's lazy
//     status sync runs).
//   - comments: only status='published'.
//   - votes: distinct polls voted on while signed in (poll_votes.user_id, which
//     the vote path fills going forward).
//
// Plan: _plans/2026-06-29-contributor-profiles-gamification.md.

import "server-only";

import { one } from "@/lib/db";
import {
  pointsFor,
  rankForPoints,
  type ContributionCounts,
  type ResolvedRank,
} from "@/lib/contributor-rank";
import { getUserById, isSuspended } from "@/lib/users";

export interface ContributionStats extends ContributionCounts {
  points: number;
  rank: ResolvedRank;
}

function n(row: { n: number } | null): number {
  return Number(row?.n ?? 0);
}

/** Live contribution counts + resolved rank for a user. Returns a zeroed,
 *  Newcomer rank for an empty id rather than throwing. */
export async function getContributionStats(
  userId: string,
): Promise<ContributionStats> {
  if (!userId) {
    return { submissions: 0, comments: 0, votes: 0, points: 0, rank: rankForPoints(0) };
  }
  const [subs, comments, votes] = await Promise.all([
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM submissions s
        WHERE s.user_id = ? AND s.story_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM stories st
             WHERE st.id = s.story_id AND st.status = 'published'
          )`,
      [userId],
    ),
    one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM comments WHERE author_user_id = ? AND status = 'published'",
      [userId],
    ),
    one<{ n: number }>(
      "SELECT COUNT(DISTINCT poll_id) AS n FROM poll_votes WHERE user_id = ?",
      [userId],
    ),
  ]);
  const counts: ContributionCounts = {
    submissions: n(subs),
    comments: n(comments),
    votes: n(votes),
  };
  const points = pointsFor(counts);
  return { ...counts, points, rank: rankForPoints(points) };
}

export interface PublicProfile {
  userId: string;
  name: string;
  pictureUrl: string | null;
  memberSince: string | null;
  stats: ContributionStats;
}

/** Public-safe profile for a user, or null when the user is missing, suspended,
 *  or has hidden their profile. Limited view by construction: only name, avatar,
 *  member-since, and the contribution counts — never email, role, or status. */
export async function getPublicProfile(
  userId: string,
): Promise<PublicProfile | null> {
  if (!userId) return null;
  const user = await getUserById(userId);
  if (!user) return null;
  if (isSuspended(user.status)) return null;
  if (Number(user.profile_hidden) === 1) return null;
  const stats = await getContributionStats(userId);
  return {
    userId: user.id,
    // Neutral fallback matching resolveDisplayName in lib/submissions.ts — never
    // expose an email-derived name on the public profile (rule 13).
    name: user.name?.trim() || "Anonymous",
    pictureUrl: user.picture_url ?? null,
    memberSince: user.created_at ?? null,
    stats,
  };
}

/** Is this user's public profile visible (exists, not suspended, not hidden)?
 *  Cheap single-row read used by the story byline + comment author links to
 *  decide whether to LINK a name or render it as plain text. */
export async function isProfilePublic(userId: string): Promise<boolean> {
  if (!userId) return false;
  const row = await one<{ status: string | null; profile_hidden: number | null }>(
    "SELECT status, profile_hidden FROM users WHERE id = ?",
    [userId],
  );
  if (!row) return false;
  if (isSuspended(row.status)) return false;
  return Number(row.profile_hidden) !== 1;
}
