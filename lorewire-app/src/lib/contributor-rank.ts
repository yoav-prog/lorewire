// Contributor points + rank. Pure and client-safe (no "server-only" import) so
// the public profile page, the dashboard card, and any badge share ONE source of
// truth for the math. The DB counts live next door in lib/contributions.ts.
//
// Scoring rewards higher-effort, post-moderation contributions and weights votes
// low on purpose: a published submission (which costs a render and passed human
// review) should dominate, and rank must not be farmable by spamming votes.
//
// Plan: _plans/2026-06-29-contributor-profiles-gamification.md.

export interface ContributionCounts {
  /** Submissions that became a live published story. */
  submissions: number;
  /** Published (post-moderation) comments. */
  comments: number;
  /** Distinct polls the user has voted on while signed in. */
  votes: number;
}

export const POINT_WEIGHTS = {
  submission: 25,
  comment: 5,
  vote: 1,
} as const;

export function pointsFor(counts: ContributionCounts): number {
  return (
    counts.submissions * POINT_WEIGHTS.submission +
    counts.comments * POINT_WEIGHTS.comment +
    counts.votes * POINT_WEIGHTS.vote
  );
}

export interface RankTier {
  /** Display name. Lore-themed on purpose, not generic bronze/silver/gold. */
  name: string;
  /** Points needed to enter this tier. Ascending; first tier is 0. */
  floor: number;
}

export const RANK_TIERS: readonly RankTier[] = [
  { name: "Newcomer", floor: 0 },
  { name: "Contributor", floor: 10 },
  { name: "Storyteller", floor: 50 },
  { name: "Chronicler", floor: 150 },
  { name: "Loremaster", floor: 400 },
  { name: "Legend", floor: 1000 },
];

export interface ResolvedRank {
  /** 1-based tier index (1 = Newcomer). */
  tier: number;
  name: string;
  /** Current tier's floor. */
  floor: number;
  /** Next tier's name, or null at the top tier. */
  next: string | null;
  /** Points that unlock the next tier, or null at the top. */
  nextAt: number | null;
  /** Points still needed to reach the next tier (0 at the top). */
  toNext: number;
  /** 0..1 progress through the current tier toward the next (1 at the top). */
  progress: number;
  /** The points this rank was resolved from (floored, never negative). */
  points: number;
}

/** Resolve a point total to its rank: current tier, the next tier, and the
 *  progress between them for the progress bar. Clamps negatives to 0. */
export function rankForPoints(points: number): ResolvedRank {
  const p = Math.max(0, Math.floor(Number.isFinite(points) ? points : 0));
  let idx = 0;
  for (let i = 0; i < RANK_TIERS.length; i++) {
    if (p >= RANK_TIERS[i].floor) idx = i;
  }
  const current = RANK_TIERS[idx];
  const next = idx < RANK_TIERS.length - 1 ? RANK_TIERS[idx + 1] : null;
  const span = next ? next.floor - current.floor : 0;
  const progress = next && span > 0 ? Math.min(1, (p - current.floor) / span) : 1;
  return {
    tier: idx + 1,
    name: current.name,
    floor: current.floor,
    next: next ? next.name : null,
    nextAt: next ? next.floor : null,
    toNext: next ? Math.max(0, next.floor - p) : 0,
    progress,
    points: p,
  };
}
