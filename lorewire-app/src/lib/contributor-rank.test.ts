// Pure unit tests for the contributor scoring + rank math. No DB, no network.
// Plan: _plans/2026-06-29-contributor-profiles-gamification.md.

import { describe, expect, it } from "vitest";

import {
  POINT_WEIGHTS,
  RANK_TIERS,
  pointsFor,
  rankForPoints,
} from "@/lib/contributor-rank";

describe("pointsFor", () => {
  it("weights a published submission far above a comment far above a vote", () => {
    expect(POINT_WEIGHTS.submission).toBeGreaterThan(POINT_WEIGHTS.comment);
    expect(POINT_WEIGHTS.comment).toBeGreaterThan(POINT_WEIGHTS.vote);
  });

  it("sums the weighted counts", () => {
    expect(pointsFor({ submissions: 2, comments: 3, votes: 4 })).toBe(
      2 * 25 + 3 * 5 + 4 * 1,
    );
  });

  it("is zero for no activity", () => {
    expect(pointsFor({ submissions: 0, comments: 0, votes: 0 })).toBe(0);
  });

  it("can't be farmed to a high rank by votes alone", () => {
    // 60 votes is a lot of clicking but should not outrank one published
    // submission (25 pts) by much — it stays in an early tier.
    const viaVotes = rankForPoints(pointsFor({ submissions: 0, comments: 0, votes: 60 }));
    expect(viaVotes.name).not.toBe("Loremaster");
    expect(viaVotes.name).not.toBe("Legend");
  });
});

describe("rankForPoints", () => {
  it("starts at Newcomer with zero points", () => {
    const r = rankForPoints(0);
    expect(r.tier).toBe(1);
    expect(r.name).toBe("Newcomer");
    expect(r.next).toBe("Contributor");
    expect(r.nextAt).toBe(10);
  });

  it("lands on the right tier at each floor boundary", () => {
    for (const t of RANK_TIERS) {
      expect(rankForPoints(t.floor).name).toBe(t.name);
    }
  });

  it("sits in the lower tier just below a boundary", () => {
    expect(rankForPoints(9).name).toBe("Newcomer");
    expect(rankForPoints(49).name).toBe("Contributor");
    expect(rankForPoints(149).name).toBe("Storyteller");
  });

  it("caps at the top tier with full progress and no next", () => {
    const r = rankForPoints(99999);
    expect(r.name).toBe("Legend");
    expect(r.next).toBeNull();
    expect(r.nextAt).toBeNull();
    expect(r.toNext).toBe(0);
    expect(r.progress).toBe(1);
  });

  it("reports progress through the current tier toward the next", () => {
    // Halfway from Contributor (10) to Storyteller (50) is 30 points.
    const r = rankForPoints(30);
    expect(r.name).toBe("Contributor");
    expect(r.progress).toBeCloseTo(0.5, 6);
    expect(r.toNext).toBe(20);
  });

  it("clamps negative / non-finite input to zero", () => {
    expect(rankForPoints(-100).points).toBe(0);
    expect(rankForPoints(Number.NaN).name).toBe("Newcomer");
  });
});
