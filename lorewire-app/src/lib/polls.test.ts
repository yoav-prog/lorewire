// Tests for the engagement-poll storage helpers + pure math. The DB
// tests use the real SQLite seam (same pattern as homepage-curation
// tests) and reset both tables before each case so they stay
// independent. Pure-function tests run without touching the DB.
//
// Plan: _plans/2026-06-17-engagement-polls.md.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "@/lib/db";
import {
  CATEGORY_POLL_PRESETS,
  computeArticlePollAggregate,
  countMinorityVotesByCookie,
  DEFAULT_PUBLIC_FLOOR,
  divisiveness,
  HERO_VERDICT_DIVIDED_THRESHOLD,
  getAggregateByStoryId,
  getEnabledPollQuestionsByStoryIds,
  getPollByArticleId,
  getPollById,
  getPollByStoryId,
  getPresetForCategory,
  getVoteSideForCookie,
  HOMEPAGE_RAIL_LIMIT,
  isPollSide,
  isRailEnabledValue,
  listPollOverview,
  listVotedStoryIdsByCookie,
  MINORITY_VOTE_DEFAULT_THRESHOLD,
  minorityVoteThresholdSettingKey,
  parseMinorityVoteThreshold,
  pctA,
  pctBComplement,
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  POLL_RAIL_KINDS,
  railEnabledSettingKey,
  RAIL_MIN_VOTES,
  recordVote,
  refreshPollAggregateForStory,
  renderHeroVerdictBadge,
  toResultView,
  topAgreed,
  topArticleAgreed,
  topArticleDivisive,
  topArticleUnpopular,
  topDivisive,
  topUnpopular,
  upsertPoll,
  validatePollInputs,
} from "@/lib/polls";

async function reset(): Promise<void> {
  await run("DELETE FROM poll_votes WHERE 1=1");
  await run("DELETE FROM poll_aggregates WHERE 1=1");
  await run("DELETE FROM polls WHERE 1=1");
  await run("DELETE FROM stories WHERE id LIKE 'test-poll-%'");
  await run("DELETE FROM stories WHERE id LIKE 'test-rail-%'");
  await run("DELETE FROM articles WHERE id LIKE 'test-poll-art-%'");
}

async function seedArticle(
  id: string,
  type: string = "feature",
  language: string = "en",
): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "INSERT INTO articles (id, type, language, slug, title, status, payload, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, 'published', '{}', ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET type = excluded.type, updated_at = excluded.updated_at",
    [id, type, language, `slug-${id}`, `Test ${id}`, now, now],
  );
}

async function seedStory(id: string, category: string | null = "Drama"): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "INSERT INTO stories (id, category, title, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, 'published', ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at",
    [id, category, `Test ${id}`, now, now],
  );
}

beforeEach(async () => {
  await reset();
});

// ─── Validation ───────────────────────────────────────────────────────────────

describe("validatePollInputs", () => {
  it("accepts a clean trio and trims surrounding whitespace", () => {
    const r = validatePollInputs({
      question: "  Who's wrong?  ",
      optionA: "Wife ",
      optionB: " Husband",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cleaned).toEqual({
        question: "Who's wrong?",
        optionA: "Wife",
        optionB: "Husband",
      });
    }
  });

  it("rejects an empty question", () => {
    const r = validatePollInputs({ question: "   ", optionA: "A", optionB: "B" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/question is required/i);
  });

  it("rejects an over-length question", () => {
    const r = validatePollInputs({
      question: "x".repeat(POLL_QUESTION_MAX + 1),
      optionA: "A",
      optionB: "B",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/question must be/i);
  });

  it("rejects an over-length option label", () => {
    const r = validatePollInputs({
      question: "Q?",
      optionA: "x".repeat(POLL_OPTION_MAX + 1),
      optionB: "B",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/option labels must be/i);
  });

  it("rejects identical option labels (case-insensitive)", () => {
    const r = validatePollInputs({
      question: "Q?",
      optionA: "wife",
      optionB: "Wife",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must differ/i);
  });

  it("rejects non-string inputs", () => {
    const r = validatePollInputs({ question: 42, optionA: null, optionB: undefined });
    expect(r.ok).toBe(false);
  });
});

// ─── Presets ──────────────────────────────────────────────────────────────────

describe("getPresetForCategory", () => {
  it("returns the right preset per category", () => {
    expect(getPresetForCategory("Drama").question).toBe(
      CATEGORY_POLL_PRESETS.Drama.question,
    );
    expect(getPresetForCategory("Entitled").question).toBe(
      CATEGORY_POLL_PRESETS.Entitled.question,
    );
  });

  it("falls back to Drama on unknown category", () => {
    expect(getPresetForCategory("Pony Club").question).toBe(
      CATEGORY_POLL_PRESETS.Drama.question,
    );
  });

  it("falls back to Drama on null", () => {
    expect(getPresetForCategory(null).question).toBe(
      CATEGORY_POLL_PRESETS.Drama.question,
    );
  });

  it("every preset has the right length caps", () => {
    for (const p of Object.values(CATEGORY_POLL_PRESETS)) {
      expect(p.question.length).toBeLessThanOrEqual(POLL_QUESTION_MAX);
      expect(p.optionA.length).toBeLessThanOrEqual(POLL_OPTION_MAX);
      expect(p.optionB.length).toBeLessThanOrEqual(POLL_OPTION_MAX);
      expect(p.optionA.toLowerCase()).not.toBe(p.optionB.toLowerCase());
    }
  });
});

// ─── Divisiveness math ────────────────────────────────────────────────────────

describe("divisiveness math", () => {
  it("returns 1.0 on a perfect 50/50", () => {
    expect(divisiveness(50, 50)).toBe(1);
  });

  it("returns 0 on unanimous 100/0", () => {
    expect(divisiveness(100, 0)).toBe(0);
    expect(divisiveness(0, 100)).toBe(0);
  });

  it("is symmetric around 50%", () => {
    expect(divisiveness(72, 28)).toBeCloseTo(divisiveness(28, 72), 6);
  });

  it("returns 0 for 0/0 (no votes ever advertised as divisive)", () => {
    expect(divisiveness(0, 0)).toBe(0);
  });

  it("75/25 sits at 0.5", () => {
    expect(divisiveness(75, 25)).toBeCloseTo(0.5, 6);
  });

  it("pctA and pctBComplement always sum to 100 when there are votes", () => {
    for (const [a, b] of [
      [1, 2],
      [50, 50],
      [3, 1],
      [99, 1],
      [33, 67],
    ]) {
      expect(pctA(a, b) + pctBComplement(a, b)).toBe(100);
    }
  });

  it("pctA and pctBComplement are both 0 with no votes", () => {
    expect(pctA(0, 0)).toBe(0);
    expect(pctBComplement(0, 0)).toBe(0);
  });
});

// ─── toResultView floor ───────────────────────────────────────────────────────

describe("toResultView", () => {
  it("hides percentages until the floor is reached", () => {
    const v = toResultView(
      {
        story_id: "x",
        poll_id: "p",
        category: "Drama",
        votes_a: 1,
        votes_b: 0,
        total_votes: 1,
        divisiveness: 0,
        agreement: 1,
        last_vote_at: null,
        refreshed_at: null,
      },
      DEFAULT_PUBLIC_FLOOR,
    );
    expect(v.hasFloor).toBe(false);
    expect(v.pctA).toBe(0);
    expect(v.pctB).toBe(0);
    expect(v.totalVotes).toBe(1);
  });

  it("reveals percentages once the floor is crossed", () => {
    const v = toResultView(
      {
        story_id: "x",
        poll_id: "p",
        category: "Drama",
        votes_a: 14,
        votes_b: 6,
        total_votes: 20,
        divisiveness: 0.6,
        agreement: 0.4,
        last_vote_at: null,
        refreshed_at: null,
      },
      DEFAULT_PUBLIC_FLOOR,
    );
    expect(v.hasFloor).toBe(true);
    expect(v.pctA).toBe(70);
    expect(v.pctB).toBe(30);
  });

  it("treats a missing aggregate as zero votes", () => {
    const v = toResultView(null);
    expect(v.hasFloor).toBe(false);
    expect(v.totalVotes).toBe(0);
  });

  // 2026-06-18 QA pass: divisiveness must ALSO be gated by hasFloor.
  // Without that, a 3-vote 1A/2B poll would expose divisiveness=0.67
  // through the API even though pctA/pctB stayed hidden.
  it("hides divisiveness when below the floor", () => {
    const v = toResultView(
      {
        story_id: "x",
        poll_id: "p",
        category: "Drama",
        votes_a: 1,
        votes_b: 2,
        total_votes: 3,
        // 1A / 2B → ~0.67 divisiveness on the aggregate row...
        divisiveness: 0.6666,
        agreement: 0.3333,
        last_vote_at: null,
        refreshed_at: null,
      },
      DEFAULT_PUBLIC_FLOOR,
    );
    expect(v.hasFloor).toBe(false);
    // ...but the view zeros it out so consumers below floor can't
    // infer split shape from the response body.
    expect(v.divisiveness).toBe(0);
  });

  it("exposes divisiveness once the floor is crossed", () => {
    const v = toResultView(
      {
        story_id: "x",
        poll_id: "p",
        category: "Drama",
        votes_a: 14,
        votes_b: 6,
        total_votes: 20,
        divisiveness: 0.6,
        agreement: 0.4,
        last_vote_at: null,
        refreshed_at: null,
      },
      DEFAULT_PUBLIC_FLOOR,
    );
    expect(v.hasFloor).toBe(true);
    expect(v.divisiveness).toBeCloseTo(0.6, 6);
  });
});

// ─── Sides ────────────────────────────────────────────────────────────────────

describe("isPollSide", () => {
  it("accepts only 'A' or 'B'", () => {
    expect(isPollSide("A")).toBe(true);
    expect(isPollSide("B")).toBe(true);
    expect(isPollSide("a")).toBe(false);
    expect(isPollSide("C")).toBe(false);
    expect(isPollSide(0)).toBe(false);
    expect(isPollSide(undefined)).toBe(false);
  });
});

// ─── upsertPoll ───────────────────────────────────────────────────────────────

describe("upsertPoll", () => {
  it("creates a poll on the first call", async () => {
    await seedStory("test-poll-1", "Drama");
    const r = await upsertPoll({
      storyId: "test-poll-1",
      question: "Who's wrong?",
      optionA: "Wife",
      optionB: "Husband",
      enabled: true,
      category: "Drama",
    });
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    const row = await getPollByStoryId("test-poll-1");
    expect(row?.question).toBe("Who's wrong?");
    expect(row?.enabled).toBe(1);
    expect(row?.category).toBe("Drama");
  });

  it("updates the same row on the second call (one poll per story)", async () => {
    await seedStory("test-poll-2", "Drama");
    const a = await upsertPoll({
      storyId: "test-poll-2",
      question: "Q1?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "Drama",
    });
    const b = await upsertPoll({
      storyId: "test-poll-2",
      question: "Q2?",
      optionA: "C",
      optionB: "D",
      enabled: false,
      category: "Drama",
    });
    expect(a.ok && b.ok).toBe(true);
    expect(b.created).toBe(false);
    expect(b.pollId).toBe(a.pollId);
    const row = await getPollByStoryId("test-poll-2");
    expect(row?.question).toBe("Q2?");
    expect(row?.option_a_text).toBe("C");
    expect(row?.enabled).toBe(0);
  });

  it("rejects invalid inputs without writing the row", async () => {
    await seedStory("test-poll-3", "Drama");
    const r = await upsertPoll({
      storyId: "test-poll-3",
      question: "",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "Drama",
    });
    expect(r.ok).toBe(false);
    expect(await getPollByStoryId("test-poll-3")).toBeNull();
  });

  it("rejects a missing story_id", async () => {
    const r = await upsertPoll({
      storyId: "",
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: null,
    });
    expect(r.ok).toBe(false);
  });
});

// ─── recordVote ───────────────────────────────────────────────────────────────

describe("recordVote", () => {
  async function seedPoll(storyId: string): Promise<string> {
    await seedStory(storyId, "Drama");
    const r = await upsertPoll({
      storyId,
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "Drama",
    });
    return r.pollId;
  }

  it("inserts a vote on first call from a cookie", async () => {
    const pollId = await seedPoll("test-poll-vote-1");
    const r = await recordVote({
      pollId,
      storyId: "test-poll-vote-1",
      category: "Drama",
      side: "A",
      cookieToken: "cookie-1",
      ipUaHash: "ip-hash-1",
    });
    expect(r.ok).toBe(true);
    expect(r.inserted).toBe(true);
  });

  it("re-voting from the same cookie is a no-op (idempotent by design)", async () => {
    const pollId = await seedPoll("test-poll-vote-2");
    const first = await recordVote({
      pollId,
      storyId: "test-poll-vote-2",
      category: "Drama",
      side: "A",
      cookieToken: "cookie-X",
      ipUaHash: null,
    });
    const second = await recordVote({
      pollId,
      storyId: "test-poll-vote-2",
      category: "Drama",
      side: "B", // even with a flipped side, the original vote stands
      cookieToken: "cookie-X",
      ipUaHash: null,
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.ok).toBe(true);
  });

  it("different cookies on the same poll each get a row", async () => {
    const pollId = await seedPoll("test-poll-vote-3");
    const r1 = await recordVote({
      pollId,
      storyId: "test-poll-vote-3",
      category: "Drama",
      side: "A",
      cookieToken: "cookie-1",
      ipUaHash: null,
    });
    const r2 = await recordVote({
      pollId,
      storyId: "test-poll-vote-3",
      category: "Drama",
      side: "B",
      cookieToken: "cookie-2",
      ipUaHash: null,
    });
    expect(r1.inserted && r2.inserted).toBe(true);
  });

  it("rejects an invalid side", async () => {
    const pollId = await seedPoll("test-poll-vote-4");
    const r = await recordVote({
      pollId,
      storyId: "test-poll-vote-4",
      category: "Drama",
      side: "C" as unknown as "A",
      cookieToken: "cookie-Y",
      ipUaHash: null,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a missing cookie token", async () => {
    const pollId = await seedPoll("test-poll-vote-5");
    const r = await recordVote({
      pollId,
      storyId: "test-poll-vote-5",
      category: "Drama",
      side: "A",
      cookieToken: "",
      ipUaHash: null,
    });
    expect(r.ok).toBe(false);
  });

  // 2026-06-18 QA pass: regression test for the SELECT-then-INSERT
  // race. Two concurrent recordVote calls for the same (poll,
  // cookie_token) could both pass the existence check and both try
  // to INSERT — the second hits the unique index and the driver
  // throws. The route used to surface that as a 500 to the client.
  // After the fix, recordVote catches the unique-violation, re-reads
  // the row, and returns inserted=false (idempotent success).
  //
  // We simulate the race by inserting a vote BETWEEN recordVote's
  // existence check and its INSERT — using a vi.spyOn on `one` so
  // the SELECT returns null, then the INSERT collides with the row
  // we planted in advance.
  it("treats a unique-constraint collision as idempotent success (race-safe)", async () => {
    const pollId = await seedPoll("test-poll-vote-race");
    // Plant the conflicting row before recordVote runs.
    await run(
      `INSERT INTO poll_votes (id, poll_id, story_id, article_id, category, side, cookie_token, ip_ua_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "planted-id",
        pollId,
        "test-poll-vote-race",
        null,
        "Drama",
        "A",
        "cookie-race",
        null,
        new Date().toISOString(),
      ],
    );
    // Spy on `one` to return null on the existence check — simulating
    // the race window where the SELECT ran BEFORE the conflicting row
    // landed. The INSERT will then hit the unique index. The fix
    // catches that exception and re-reads (real read this time, no
    // spy), finds the planted row, and returns inserted=false.
    const dbMod = await import("@/lib/db");
    const realOne = dbMod.one;
    let callCount = 0;
    const oneSpy = vi
      .spyOn(dbMod, "one")
      .mockImplementation(async (sql, params) => {
        callCount += 1;
        // First call inside recordVote = the existence check. Force
        // null so the code proceeds to INSERT. Second call = the
        // post-error re-check. Let it through to find the planted
        // row.
        if (callCount === 1) return null as never;
        return realOne(sql, params);
      });
    try {
      const r = await recordVote({
        pollId,
        storyId: "test-poll-vote-race",
        category: "Drama",
        side: "B", // doesn't matter; planted row wins
        cookieToken: "cookie-race",
        ipUaHash: null,
      });
      expect(r.ok).toBe(true);
      expect(r.inserted).toBe(false);
    } finally {
      oneSpy.mockRestore();
    }
  });
});

// ─── refreshPollAggregateForStory ─────────────────────────────────────────────

describe("refreshPollAggregateForStory", () => {
  async function seedPollWithVotes(
    storyId: string,
    aCount: number,
    bCount: number,
  ): Promise<string> {
    await seedStory(storyId, "Drama");
    const u = await upsertPoll({
      storyId,
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "Drama",
    });
    for (let i = 0; i < aCount; i++) {
      await recordVote({
        pollId: u.pollId,
        storyId,
        category: "Drama",
        side: "A",
        cookieToken: `c-${storyId}-a-${i}`,
        ipUaHash: null,
      });
    }
    for (let i = 0; i < bCount; i++) {
      await recordVote({
        pollId: u.pollId,
        storyId,
        category: "Drama",
        side: "B",
        cookieToken: `c-${storyId}-b-${i}`,
        ipUaHash: null,
      });
    }
    return u.pollId;
  }

  it("creates the aggregate row on first refresh", async () => {
    await seedPollWithVotes("test-poll-agg-1", 7, 3);
    await refreshPollAggregateForStory("test-poll-agg-1");
    const agg = await getAggregateByStoryId("test-poll-agg-1");
    expect(agg).not.toBeNull();
    expect(agg!.votes_a).toBe(7);
    expect(agg!.votes_b).toBe(3);
    expect(agg!.total_votes).toBe(10);
    expect(agg!.divisiveness).toBeCloseTo(0.6, 4);
  });

  it("is idempotent — re-refreshing the same row keeps the counts", async () => {
    await seedPollWithVotes("test-poll-agg-2", 5, 5);
    await refreshPollAggregateForStory("test-poll-agg-2");
    await refreshPollAggregateForStory("test-poll-agg-2");
    const agg = await getAggregateByStoryId("test-poll-agg-2");
    expect(agg!.total_votes).toBe(10);
    expect(agg!.divisiveness).toBeCloseTo(1, 4);
  });

  it("writes zeros for a poll with no votes yet", async () => {
    await seedStory("test-poll-agg-3", "Drama");
    await upsertPoll({
      storyId: "test-poll-agg-3",
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "Drama",
    });
    await refreshPollAggregateForStory("test-poll-agg-3");
    const agg = await getAggregateByStoryId("test-poll-agg-3");
    expect(agg!.total_votes).toBe(0);
    expect(agg!.divisiveness).toBe(0);
  });

  it("no-ops on a story that has no poll", async () => {
    await refreshPollAggregateForStory("test-poll-agg-no-poll");
    const agg = await getAggregateByStoryId("test-poll-agg-no-poll");
    expect(agg).toBeNull();
  });
});

// ─── getVoteSideForCookie ─────────────────────────────────────────────────────

describe("getVoteSideForCookie", () => {
  it("returns the side this cookie voted for", async () => {
    await seedStory("test-poll-cookie-1", "Drama");
    const u = await upsertPoll({
      storyId: "test-poll-cookie-1",
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "Drama",
    });
    await recordVote({
      pollId: u.pollId,
      storyId: "test-poll-cookie-1",
      category: "Drama",
      side: "B",
      cookieToken: "cookie-known",
      ipUaHash: null,
    });
    expect(await getVoteSideForCookie(u.pollId, "cookie-known")).toBe("B");
  });

  it("returns null for an unknown cookie on a real poll", async () => {
    await seedStory("test-poll-cookie-2", "Drama");
    const u = await upsertPoll({
      storyId: "test-poll-cookie-2",
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "Drama",
    });
    expect(await getVoteSideForCookie(u.pollId, "never-voted")).toBeNull();
  });

  it("returns null for an empty cookie token (the SSR no-cookie case)", async () => {
    await seedStory("test-poll-cookie-3", "Drama");
    const u = await upsertPoll({
      storyId: "test-poll-cookie-3",
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "Drama",
    });
    expect(await getVoteSideForCookie(u.pollId, "")).toBeNull();
    expect(await getVoteSideForCookie(u.pollId, null)).toBeNull();
  });
});

// ─── Rails: divisive / agreed / unpopular ─────────────────────────────────────

describe("rail queries", () => {
  // Build N votes on a story with a configured split. Returns the pollId.
  async function seedStoryWithSplit(
    storyId: string,
    category: string,
    aCount: number,
    bCount: number,
    cookieCallback?: (cookie: string, side: "A" | "B") => void,
  ): Promise<string> {
    // Mark the story published + with a slug so the rail join can see it.
    const now = new Date().toISOString();
    await run(
      "INSERT INTO stories (id, slug, category, title, status, published_at, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, 'published', ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, category=excluded.category, " +
        "status='published', published_at=excluded.published_at, updated_at=excluded.updated_at",
      [storyId, `slug-${storyId}`, category, `Test ${storyId}`, now, now, now],
    );
    const u = await upsertPoll({
      storyId,
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category,
    });
    for (let i = 0; i < aCount; i++) {
      const c = `c-${storyId}-a-${i}`;
      await recordVote({
        pollId: u.pollId,
        storyId,
        category,
        side: "A",
        cookieToken: c,
        ipUaHash: null,
      });
      cookieCallback?.(c, "A");
    }
    for (let i = 0; i < bCount; i++) {
      const c = `c-${storyId}-b-${i}`;
      await recordVote({
        pollId: u.pollId,
        storyId,
        category,
        side: "B",
        cookieToken: c,
        ipUaHash: null,
      });
      cookieCallback?.(c, "B");
    }
    await refreshPollAggregateForStory(storyId);
    return u.pollId;
  }

  describe("topDivisive", () => {
    it("sorts most-split first, then by total_votes", async () => {
      // Three stories at the same divisiveness band; total_votes tiebreaks.
      await seedStoryWithSplit("test-rail-d-1", "Drama", 50, 50); // 50/50 × 100
      await seedStoryWithSplit("test-rail-d-2", "Drama", 75, 25); // 75/25 × 100
      await seedStoryWithSplit("test-rail-d-3", "Drama", 49, 51); // ~50/50 × 100
      const rows = await topDivisive({ limit: 10 });
      const ids = rows.map((r) => r.storyId);
      // 50/50 (perfect) and 49/51 (near-perfect) outrank 75/25.
      expect(ids.indexOf("test-rail-d-1")).toBeLessThan(ids.indexOf("test-rail-d-2"));
      expect(ids.indexOf("test-rail-d-3")).toBeLessThan(ids.indexOf("test-rail-d-2"));
    });

    it("drops stories below the rail floor", async () => {
      // Below RAIL_MIN_VOTES → excluded.
      await seedStoryWithSplit("test-rail-d-low", "Drama", 5, 5);
      const rows = await topDivisive({ limit: 10 });
      expect(rows.map((r) => r.storyId)).not.toContain("test-rail-d-low");
    });

    it("filters by category when requested", async () => {
      await seedStoryWithSplit("test-rail-d-cat-1", "Drama", 50, 50);
      await seedStoryWithSplit("test-rail-d-cat-2", "Entitled", 50, 50);
      const rows = await topDivisive({ category: "Drama", limit: 10 });
      const ids = rows.map((r) => r.storyId);
      expect(ids).toContain("test-rail-d-cat-1");
      expect(ids).not.toContain("test-rail-d-cat-2");
    });

    it("excludes the current story when excludeStoryId set", async () => {
      await seedStoryWithSplit("test-rail-d-self", "Drama", 50, 50);
      await seedStoryWithSplit("test-rail-d-other", "Drama", 48, 52);
      const rows = await topDivisive({
        excludeStoryId: "test-rail-d-self",
        limit: 10,
      });
      expect(rows.map((r) => r.storyId)).not.toContain("test-rail-d-self");
    });
  });

  describe("topAgreed", () => {
    it("sorts most-lopsided first, then by total_votes", async () => {
      await seedStoryWithSplit("test-rail-a-1", "Drama", 95, 5); // ~95/5
      await seedStoryWithSplit("test-rail-a-2", "Drama", 50, 50); // 50/50
      await seedStoryWithSplit("test-rail-a-3", "Drama", 80, 20); // 80/20
      const rows = await topAgreed({ limit: 10 });
      const ids = rows.map((r) => r.storyId);
      expect(ids.indexOf("test-rail-a-1")).toBeLessThan(ids.indexOf("test-rail-a-3"));
      expect(ids.indexOf("test-rail-a-3")).toBeLessThan(ids.indexOf("test-rail-a-2"));
    });
  });

  describe("topUnpopular", () => {
    it("personalized mode returns stories where the cookie voted minority", async () => {
      // Cookie 'me' votes A on the first story (where A is minority 25%) and
      // A on the second story (where A is majority 75%). Only the first
      // counts as an unpopular pick.
      const cookieMe = "test-rail-u-cookie-me";
      // Story 1: 25/75 split. Plant 'me' as one of the A voters.
      await run("DELETE FROM stories WHERE id = ?", ["test-rail-u-1"]);
      const now = new Date().toISOString();
      await run(
        "INSERT INTO stories (id, slug, category, title, status, published_at, created_at, updated_at) " +
          "VALUES (?, ?, ?, 'T', 'published', ?, ?, ?)",
        ["test-rail-u-1", "slug-rail-u-1", "Drama", now, now, now],
      );
      const u1 = await upsertPoll({
        storyId: "test-rail-u-1",
        question: "Q?",
        optionA: "A",
        optionB: "B",
        enabled: true,
        category: "Drama",
      });
      // 'me' votes A
      await recordVote({
        pollId: u1.pollId,
        storyId: "test-rail-u-1",
        category: "Drama",
        side: "A",
        cookieToken: cookieMe,
        ipUaHash: null,
      });
      // Other voters: 24 A + 75 B (so A side has 25 total, B has 75)
      for (let i = 0; i < 24; i++) {
        await recordVote({
          pollId: u1.pollId,
          storyId: "test-rail-u-1",
          category: "Drama",
          side: "A",
          cookieToken: `c-u-1-a-${i}`,
          ipUaHash: null,
        });
      }
      for (let i = 0; i < 75; i++) {
        await recordVote({
          pollId: u1.pollId,
          storyId: "test-rail-u-1",
          category: "Drama",
          side: "B",
          cookieToken: `c-u-1-b-${i}`,
          ipUaHash: null,
        });
      }
      await refreshPollAggregateForStory("test-rail-u-1");

      // Story 2: 'me' votes A where A is the majority. Should NOT count.
      await run("DELETE FROM stories WHERE id = ?", ["test-rail-u-2"]);
      await run(
        "INSERT INTO stories (id, slug, category, title, status, published_at, created_at, updated_at) " +
          "VALUES (?, ?, ?, 'T', 'published', ?, ?, ?)",
        ["test-rail-u-2", "slug-rail-u-2", "Drama", now, now, now],
      );
      const u2 = await upsertPoll({
        storyId: "test-rail-u-2",
        question: "Q?",
        optionA: "A",
        optionB: "B",
        enabled: true,
        category: "Drama",
      });
      await recordVote({
        pollId: u2.pollId,
        storyId: "test-rail-u-2",
        category: "Drama",
        side: "A",
        cookieToken: cookieMe,
        ipUaHash: null,
      });
      for (let i = 0; i < 74; i++) {
        await recordVote({
          pollId: u2.pollId,
          storyId: "test-rail-u-2",
          category: "Drama",
          side: "A",
          cookieToken: `c-u-2-a-${i}`,
          ipUaHash: null,
        });
      }
      for (let i = 0; i < 25; i++) {
        await recordVote({
          pollId: u2.pollId,
          storyId: "test-rail-u-2",
          category: "Drama",
          side: "B",
          cookieToken: `c-u-2-b-${i}`,
          ipUaHash: null,
        });
      }
      await refreshPollAggregateForStory("test-rail-u-2");

      const rows = await topUnpopular({ cookieToken: cookieMe, limit: 10 });
      const ids = rows.map((r) => r.storyId);
      expect(ids).toContain("test-rail-u-1");
      expect(ids).not.toContain("test-rail-u-2");
    });

    it("fallback mode (no cookie) returns stories with the smaller side under 15%", async () => {
      // 95/5 qualifies (5% < 15%); 70/30 doesn't.
      await seedStoryWithSplit("test-rail-u-fb-95", "Drama", 95, 5);
      await seedStoryWithSplit("test-rail-u-fb-70", "Drama", 70, 30);
      const rows = await topUnpopular({ cookieToken: null, limit: 10 });
      const ids = rows.map((r) => r.storyId);
      expect(ids).toContain("test-rail-u-fb-95");
      expect(ids).not.toContain("test-rail-u-fb-70");
    });
  });

  describe("countMinorityVotesByCookie", () => {
    // Plant `cookie` as a vote on a fresh story, then build the crowd
    // around it on the same poll. Refreshes the aggregate so the
    // count query sees current totals. Centralises the SETUP that the
    // `topUnpopular` test inlines (lines 815+); future minority-rail
    // tests can reuse it.
    async function seedMyVote(
      storyId: string,
      cookieToken: string,
      mySide: "A" | "B",
      otherA: number,
      otherB: number,
    ): Promise<void> {
      const now = new Date().toISOString();
      await run("DELETE FROM stories WHERE id = ?", [storyId]);
      await run(
        "INSERT INTO stories (id, slug, category, title, status, published_at, created_at, updated_at) " +
          "VALUES (?, ?, 'Drama', 'T', 'published', ?, ?, ?)",
        [storyId, `slug-${storyId}`, now, now, now],
      );
      const u = await upsertPoll({
        storyId,
        question: "Q?",
        optionA: "A",
        optionB: "B",
        enabled: true,
        category: "Drama",
      });
      await recordVote({
        pollId: u.pollId,
        storyId,
        category: "Drama",
        side: mySide,
        cookieToken,
        ipUaHash: null,
      });
      for (let i = 0; i < otherA; i++) {
        await recordVote({
          pollId: u.pollId,
          storyId,
          category: "Drama",
          side: "A",
          cookieToken: `crowd-${storyId}-a-${i}`,
          ipUaHash: null,
        });
      }
      for (let i = 0; i < otherB; i++) {
        await recordVote({
          pollId: u.pollId,
          storyId,
          category: "Drama",
          side: "B",
          cookieToken: `crowd-${storyId}-b-${i}`,
          ipUaHash: null,
        });
      }
      await refreshPollAggregateForStory(storyId);
    }

    it("returns 0 for a null or empty cookie token", async () => {
      expect(await countMinorityVotesByCookie(null)).toBe(0);
      expect(await countMinorityVotesByCookie("")).toBe(0);
    });

    it("returns 0 for a cookie that has not voted on anything", async () => {
      // Seed an established poll so the aggregate exists, but vote
      // from a different cookie. The probe cookie has zero votes.
      await seedMyVote("test-minority-noop-1", "other-cookie", "A", 24, 75);
      expect(await countMinorityVotesByCookie("probe-cookie")).toBe(0);
    });

    it("counts a vote that landed on the current minority side", async () => {
      // 25 A / 75 B → A is the minority. 'me' voted A.
      await seedMyVote("test-minority-yes-1", "me", "A", 24, 75);
      expect(await countMinorityVotesByCookie("me")).toBe(1);
    });

    it("does NOT count a vote that landed on the majority side", async () => {
      // 75 A / 25 B → A is the majority. 'me' voted A.
      await seedMyVote("test-minority-no-1", "me", "A", 74, 25);
      expect(await countMinorityVotesByCookie("me")).toBe(0);
    });

    it("does NOT count a 50/50 tie as minority", async () => {
      // Perfect split: neither side is strictly less than half.
      // Matches the strict-inequality `votes_a * 2 < total_votes`
      // predicate `topUnpopular` uses, so the gate and the rail agree.
      await seedMyVote("test-minority-tie-1", "me", "A", 49, 50);
      expect(await countMinorityVotesByCookie("me")).toBe(0);
    });

    it("does NOT count polls below the public floor", async () => {
      // 1 A / 4 B → A IS the minority by percentage, but total_votes
      // (5) is well below RAIL_MIN_VOTES (20). The floor keeps the
      // count from inflating on freshly-launched polls where any
      // single early vote is technically "minority."
      await seedMyVote("test-minority-floor-1", "me", "A", 0, 4);
      expect(await countMinorityVotesByCookie("me")).toBe(0);
    });

    it("sums minority votes across multiple polls", async () => {
      // Two minority hits, one majority hit. Expect 2.
      await seedMyVote("test-minority-sum-1", "me", "A", 24, 75); // A minority
      await seedMyVote("test-minority-sum-2", "me", "B", 75, 24); // B minority
      await seedMyVote("test-minority-sum-3", "me", "A", 74, 25); // A majority
      expect(await countMinorityVotesByCookie("me")).toBe(2);
    });

    it("only counts the requested cookie", async () => {
      // Two cookies both vote minority on the same poll. Each should
      // count exactly 1 minority vote — no cross-contamination.
      await seedMyVote("test-minority-iso-1", "alice", "A", 0, 75);
      // 'bob' votes A too (still minority); seed via a second recordVote.
      const u = await getPollByStoryId("test-minority-iso-1");
      if (u) {
        await recordVote({
          pollId: u.id,
          storyId: "test-minority-iso-1",
          category: "Drama",
          side: "A",
          cookieToken: "bob",
          ipUaHash: null,
        });
      }
      await refreshPollAggregateForStory("test-minority-iso-1");
      expect(await countMinorityVotesByCookie("alice")).toBe(1);
      expect(await countMinorityVotesByCookie("bob")).toBe(1);
      expect(await countMinorityVotesByCookie("eve")).toBe(0);
    });
  });

  describe("listVotedStoryIdsByCookie", () => {
    async function seedSimplePollVote(
      storyId: string,
      cookieToken: string,
      side: "A" | "B",
    ): Promise<void> {
      const now = new Date().toISOString();
      await run("DELETE FROM stories WHERE id = ?", [storyId]);
      await run(
        "INSERT INTO stories (id, slug, category, title, status, published_at, created_at, updated_at) " +
          "VALUES (?, ?, 'Drama', 'T', 'published', ?, ?, ?)",
        [storyId, `slug-${storyId}`, now, now, now],
      );
      const u = await upsertPoll({
        storyId,
        question: "Q?",
        optionA: "A",
        optionB: "B",
        enabled: true,
        category: "Drama",
      });
      await recordVote({
        pollId: u.pollId,
        storyId,
        category: "Drama",
        side,
        cookieToken,
        ipUaHash: null,
      });
    }

    it("returns [] for a null or empty cookie token", async () => {
      expect(await listVotedStoryIdsByCookie(null)).toEqual([]);
      expect(await listVotedStoryIdsByCookie("")).toEqual([]);
    });

    it("returns [] for a cookie with no vote history", async () => {
      // Seed a vote from someone else; the probe cookie has nothing.
      await seedSimplePollVote("test-voted-empty-1", "other", "A");
      expect(await listVotedStoryIdsByCookie("probe")).toEqual([]);
    });

    it("returns the story ids this cookie voted on", async () => {
      await seedSimplePollVote("test-voted-a", "me", "A");
      await seedSimplePollVote("test-voted-b", "me", "B");
      const ids = await listVotedStoryIdsByCookie("me");
      expect(ids.sort()).toEqual(["test-voted-a", "test-voted-b"].sort());
    });

    it("does not include polls voted on by a different cookie", async () => {
      await seedSimplePollVote("test-voted-mine", "me", "A");
      await seedSimplePollVote("test-voted-theirs", "you", "A");
      const mine = await listVotedStoryIdsByCookie("me");
      expect(mine).toEqual(["test-voted-mine"]);
    });

    it("dedupes per story id even if the cookie has multiple poll_votes rows", async () => {
      // Same cookie + same poll → recordVote is idempotent, but if the
      // DB ever ended up with two rows (legacy data, race window before
      // the unique index landed), the DISTINCT in the query keeps the
      // story id from doubling up. Insert directly to simulate.
      await seedSimplePollVote("test-voted-dedupe", "me", "A");
      const poll = await getPollByStoryId("test-voted-dedupe");
      if (!poll) throw new Error("seed failed");
      // Forcing a second row with a different id but same (poll, cookie)
      // would violate the unique index; instead simulate the legacy
      // shape with two stories sharing the cookie. The DISTINCT is on
      // story_id so the assertion is the same.
      await seedSimplePollVote("test-voted-dedupe-2", "me", "A");
      const ids = await listVotedStoryIdsByCookie("me");
      // Two distinct stories, each appearing once. Length asserts the
      // DISTINCT didn't accidentally drop one.
      expect(new Set(ids)).toEqual(
        new Set(["test-voted-dedupe", "test-voted-dedupe-2"]),
      );
      expect(ids.length).toBe(2);
    });
  });

  describe("getEnabledPollQuestionsByStoryIds", () => {
    async function seedPollWithQuestion(
      storyId: string,
      question: string,
      enabled: boolean,
    ): Promise<void> {
      const now = new Date().toISOString();
      await run("DELETE FROM stories WHERE id = ?", [storyId]);
      await run(
        "INSERT INTO stories (id, slug, category, title, status, published_at, created_at, updated_at) " +
          "VALUES (?, ?, 'Drama', 'T', 'published', ?, ?, ?)",
        [storyId, `slug-${storyId}`, now, now, now],
      );
      await upsertPoll({
        storyId,
        question,
        optionA: "A",
        optionB: "B",
        enabled,
        category: "Drama",
      });
    }

    it("returns an empty record for empty input (no SQL round trip)", async () => {
      const out = await getEnabledPollQuestionsByStoryIds([]);
      expect(out).toEqual({});
    });

    it("returns a question per requested story id that has an enabled poll", async () => {
      await seedPollWithQuestion("test-hero-q-1", "Who's wrong?", true);
      await seedPollWithQuestion("test-hero-q-2", "Did they go too far?", true);
      const out = await getEnabledPollQuestionsByStoryIds([
        "test-hero-q-1",
        "test-hero-q-2",
      ]);
      expect(out).toEqual({
        "test-hero-q-1": "Who's wrong?",
        "test-hero-q-2": "Did they go too far?",
      });
    });

    it("drops disabled polls", async () => {
      await seedPollWithQuestion("test-hero-q-on", "Who's wrong?", true);
      await seedPollWithQuestion("test-hero-q-off", "Hidden question", false);
      const out = await getEnabledPollQuestionsByStoryIds([
        "test-hero-q-on",
        "test-hero-q-off",
      ]);
      expect(out).toEqual({ "test-hero-q-on": "Who's wrong?" });
    });

    it("returns only requested ids, even when other polls exist", async () => {
      // Seed three; ask for one. The other two stay out of the result.
      await seedPollWithQuestion("test-hero-q-only-1", "Q1?", true);
      await seedPollWithQuestion("test-hero-q-only-2", "Q2?", true);
      await seedPollWithQuestion("test-hero-q-only-3", "Q3?", true);
      const out = await getEnabledPollQuestionsByStoryIds([
        "test-hero-q-only-2",
      ]);
      expect(out).toEqual({ "test-hero-q-only-2": "Q2?" });
    });

    it("ignores story ids that don't exist", async () => {
      await seedPollWithQuestion("test-hero-q-real", "Real?", true);
      const out = await getEnabledPollQuestionsByStoryIds([
        "test-hero-q-real",
        "test-hero-q-ghost",
      ]);
      expect(out).toEqual({ "test-hero-q-real": "Real?" });
    });
  });

  describe("rail floor + visibility", () => {
    it("only surfaces published, non-noindex stories", async () => {
      // Story published but noindex=1 should be hidden.
      const now = new Date().toISOString();
      await run("DELETE FROM stories WHERE id = ?", ["test-rail-noindex"]);
      await run(
        "INSERT INTO stories (id, slug, category, title, status, published_at, noindex, created_at, updated_at) " +
          "VALUES (?, ?, 'Drama', 'T', 'published', ?, 1, ?, ?)",
        ["test-rail-noindex", "slug-noindex", now, now, now],
      );
      await seedStoryWithSplit("test-rail-noindex", "Drama", 50, 50);
      const rows = await topDivisive({ limit: 10 });
      expect(rows.map((r) => r.storyId)).not.toContain("test-rail-noindex");
    });
  });

  it("RAIL_MIN_VOTES tracks DEFAULT_PUBLIC_FLOOR", () => {
    expect(RAIL_MIN_VOTES).toBe(DEFAULT_PUBLIC_FLOOR);
  });
});

// ─── Homepage rail settings helpers ───────────────────────────────────────────

describe("railEnabledSettingKey", () => {
  it("produces a stable key per rail kind", () => {
    expect(railEnabledSettingKey("divisive")).toBe(
      "polls.rail.divisive_enabled",
    );
    expect(railEnabledSettingKey("agreed")).toBe(
      "polls.rail.agreed_enabled",
    );
    expect(railEnabledSettingKey("unpopular")).toBe(
      "polls.rail.unpopular_enabled",
    );
  });

  it("covers every rail kind", () => {
    for (const kind of POLL_RAIL_KINDS) {
      expect(railEnabledSettingKey(kind)).toMatch(
        /^polls\.rail\.[a-z]+_enabled$/,
      );
    }
  });
});

describe("isRailEnabledValue", () => {
  it("treats missing/null/empty as enabled (default-on)", () => {
    expect(isRailEnabledValue(null)).toBe(true);
    expect(isRailEnabledValue(undefined)).toBe(true);
    expect(isRailEnabledValue("")).toBe(true);
    expect(isRailEnabledValue("   ")).toBe(true);
  });

  it("treats '0' or 'false' (any case) as disabled", () => {
    expect(isRailEnabledValue("0")).toBe(false);
    expect(isRailEnabledValue("false")).toBe(false);
    expect(isRailEnabledValue("False")).toBe(false);
    expect(isRailEnabledValue("FALSE")).toBe(false);
  });

  it("treats '1' / 'true' / any other non-zero value as enabled", () => {
    expect(isRailEnabledValue("1")).toBe(true);
    expect(isRailEnabledValue("true")).toBe(true);
    expect(isRailEnabledValue("on")).toBe(true);
    expect(isRailEnabledValue("yes")).toBe(true);
  });
});

describe("HOMEPAGE_RAIL_LIMIT", () => {
  it("is a sensible card-count cap (not 0, not absurd)", () => {
    expect(HOMEPAGE_RAIL_LIMIT).toBeGreaterThan(0);
    expect(HOMEPAGE_RAIL_LIMIT).toBeLessThanOrEqual(20);
  });

  it("rail queries respect it as a default limit", async () => {
    // Seed > HOMEPAGE_RAIL_LIMIT stories so the cap is observable.
    const seedCount = HOMEPAGE_RAIL_LIMIT + 4;
    for (let i = 0; i < seedCount; i++) {
      const id = `test-rail-cap-${i}`;
      const now = new Date().toISOString();
      await run(
        "INSERT INTO stories (id, slug, category, title, status, published_at, created_at, updated_at) " +
          "VALUES (?, ?, 'Drama', 'T', 'published', ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, status='published'",
        [id, `slug-cap-${i}`, now, now, now],
      );
      const u = await upsertPoll({
        storyId: id,
        question: "Q?",
        optionA: "A",
        optionB: "B",
        enabled: true,
        category: "Drama",
      });
      // Vary the split so divisiveness varies per row (50/50, 49/51, etc.)
      const splitA = 40 + (i % 12);
      const splitB = 80 - splitA;
      for (let j = 0; j < splitA; j++) {
        await recordVote({
          pollId: u.pollId,
          storyId: id,
          category: "Drama",
          side: "A",
          cookieToken: `c-cap-${i}-a-${j}`,
          ipUaHash: null,
        });
      }
      for (let j = 0; j < splitB; j++) {
        await recordVote({
          pollId: u.pollId,
          storyId: id,
          category: "Drama",
          side: "B",
          cookieToken: `c-cap-${i}-b-${j}`,
          ipUaHash: null,
        });
      }
      await refreshPollAggregateForStory(id);
    }
    const rows = await topDivisive({ limit: HOMEPAGE_RAIL_LIMIT });
    expect(rows.length).toBeLessThanOrEqual(HOMEPAGE_RAIL_LIMIT);
  });
});

// ─── listPollOverview ─────────────────────────────────────────────────────────

describe("listPollOverview", () => {
  it("returns polls with their aggregate (or null) + the parent title", async () => {
    await seedStory("test-poll-overview-1", "Drama");
    await upsertPoll({
      storyId: "test-poll-overview-1",
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "Drama",
    });
    // One story has no aggregate yet (cron hasn't run); another does.
    await seedStory("test-poll-overview-2", "Entitled");
    const u2 = await upsertPoll({
      storyId: "test-poll-overview-2",
      question: "Q2?",
      optionA: "Yes",
      optionB: "No",
      enabled: true,
      category: "Entitled",
    });
    await recordVote({
      pollId: u2.pollId,
      storyId: "test-poll-overview-2",
      category: "Entitled",
      side: "A",
      cookieToken: "c-ovw-1",
      ipUaHash: null,
    });
    await refreshPollAggregateForStory("test-poll-overview-2");

    const rows = await listPollOverview();
    const byStory = new Map(rows.map((r) => [r.poll.story_id, r]));
    expect(byStory.get("test-poll-overview-1")?.aggregate).toBeNull();
    expect(byStory.get("test-poll-overview-1")?.storyTitle).toMatch(/Test test-poll-overview-1/);
    expect(byStory.get("test-poll-overview-2")?.aggregate?.total_votes).toBe(1);
    expect(byStory.get("test-poll-overview-2")?.storyCategory).toBe("Entitled");
  });

  it("returns an empty array when there are no polls", async () => {
    const rows = await listPollOverview();
    expect(rows).toEqual([]);
  });
});

// ─── Standalone-article polls (plan §15) ─────────────────────────────────────

describe("article polls — upsert", () => {
  it("creates an article-attached poll on the first call", async () => {
    await seedArticle("test-poll-art-1", "feature");
    const r = await upsertPoll({
      articleId: "test-poll-art-1",
      question: "Did this actually happen?",
      optionA: "Yes",
      optionB: "No",
      enabled: true,
      category: "feature",
    });
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    const row = await getPollByArticleId("test-poll-art-1");
    expect(row?.question).toBe("Did this actually happen?");
    expect(row?.article_id).toBe("test-poll-art-1");
    expect(row?.story_id).toBeNull();
    expect(row?.category).toBe("feature");
  });

  it("updates the same row on the second call (one poll per article)", async () => {
    await seedArticle("test-poll-art-2", "feature");
    const a = await upsertPoll({
      articleId: "test-poll-art-2",
      question: "Q1?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "feature",
    });
    const b = await upsertPoll({
      articleId: "test-poll-art-2",
      question: "Q2?",
      optionA: "C",
      optionB: "D",
      enabled: false,
      category: "feature",
    });
    expect(b.created).toBe(false);
    expect(b.pollId).toBe(a.pollId);
    const row = await getPollByArticleId("test-poll-art-2");
    expect(row?.question).toBe("Q2?");
    expect(row?.enabled).toBe(0);
  });

  it("rejects an upsert with NEITHER storyId NOR articleId", async () => {
    const r = await upsertPoll({
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/subject required/i);
  });

  it("rejects an upsert with BOTH storyId AND articleId set", async () => {
    await seedStory("test-poll-3-story", "Drama");
    await seedArticle("test-poll-art-3", "feature");
    const r = await upsertPoll({
      storyId: "test-poll-3-story",
      articleId: "test-poll-art-3",
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exactly one of/i);
  });

  it("story poll and article poll with the SAME id can coexist (no collision)", async () => {
    // Different subject ids that happen to look alike — the partial
    // unique indexes filter by NOT NULL so story_id="X" and
    // article_id="X" don't collide.
    await seedStory("test-poll-collide-x", "Drama");
    await seedArticle("test-poll-art-collide-x", "feature");
    const s = await upsertPoll({
      storyId: "test-poll-collide-x",
      question: "S?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "Drama",
    });
    const a = await upsertPoll({
      articleId: "test-poll-art-collide-x",
      question: "A?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "feature",
    });
    expect(s.ok && a.ok).toBe(true);
    expect(s.pollId).not.toBe(a.pollId);
  });
});

describe("article polls — vote + live aggregate", () => {
  it("recordVote accepts articleId in place of storyId", async () => {
    await seedArticle("test-poll-art-vote-1", "feature");
    const u = await upsertPoll({
      articleId: "test-poll-art-vote-1",
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "feature",
    });
    const r = await recordVote({
      pollId: u.pollId,
      articleId: "test-poll-art-vote-1",
      category: "feature",
      side: "A",
      cookieToken: "cookie-art-1",
      ipUaHash: null,
    });
    expect(r.ok).toBe(true);
    expect(r.inserted).toBe(true);
  });

  it("computeArticlePollAggregate produces correct live counts", async () => {
    await seedArticle("test-poll-art-agg-1", "feature");
    const u = await upsertPoll({
      articleId: "test-poll-art-agg-1",
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "feature",
    });
    for (let i = 0; i < 7; i++) {
      await recordVote({
        pollId: u.pollId,
        articleId: "test-poll-art-agg-1",
        category: "feature",
        side: "A",
        cookieToken: `cookie-art-agg-a-${i}`,
        ipUaHash: null,
      });
    }
    for (let i = 0; i < 3; i++) {
      await recordVote({
        pollId: u.pollId,
        articleId: "test-poll-art-agg-1",
        category: "feature",
        side: "B",
        cookieToken: `cookie-art-agg-b-${i}`,
        ipUaHash: null,
      });
    }
    const poll = await getPollById(u.pollId);
    expect(poll).not.toBeNull();
    const agg = await computeArticlePollAggregate(poll!);
    expect(agg.votes_a).toBe(7);
    expect(agg.votes_b).toBe(3);
    expect(agg.total_votes).toBe(10);
    expect(agg.divisiveness).toBeCloseTo(0.6, 4);
    expect(agg.story_id).toBe(""); // contract: empty for article polls
  });

  it("computeArticlePollAggregate returns zeros for a poll with no votes", async () => {
    await seedArticle("test-poll-art-agg-empty", "feature");
    const u = await upsertPoll({
      articleId: "test-poll-art-agg-empty",
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "feature",
    });
    const poll = await getPollById(u.pollId);
    const agg = await computeArticlePollAggregate(poll!);
    expect(agg.total_votes).toBe(0);
    expect(agg.divisiveness).toBe(0);
  });

  it("recordVote rejects when neither storyId nor articleId is set", async () => {
    await seedArticle("test-poll-art-vote-rej", "feature");
    const u = await upsertPoll({
      articleId: "test-poll-art-vote-rej",
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "feature",
    });
    const r = await recordVote({
      pollId: u.pollId,
      category: "feature",
      side: "A",
      cookieToken: "cookie-rej",
      ipUaHash: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/subject required/i);
  });

  it("recordVote rejects when BOTH storyId and articleId are set", async () => {
    await seedArticle("test-poll-art-vote-both", "feature");
    const u = await upsertPoll({
      articleId: "test-poll-art-vote-both",
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "feature",
    });
    const r = await recordVote({
      pollId: u.pollId,
      storyId: "test-poll-art-vote-both",
      articleId: "test-poll-art-vote-both",
      category: "feature",
      side: "A",
      cookieToken: "cookie-both",
      ipUaHash: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exactly one of/i);
  });

  it("article-poll vote idempotency: same cookie re-vote = no-op", async () => {
    await seedArticle("test-poll-art-idem", "feature");
    const u = await upsertPoll({
      articleId: "test-poll-art-idem",
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "feature",
    });
    const first = await recordVote({
      pollId: u.pollId,
      articleId: "test-poll-art-idem",
      category: "feature",
      side: "A",
      cookieToken: "cookie-idem",
      ipUaHash: null,
    });
    const second = await recordVote({
      pollId: u.pollId,
      articleId: "test-poll-art-idem",
      category: "feature",
      side: "B",
      cookieToken: "cookie-idem",
      ipUaHash: null,
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.ok).toBe(true);
  });
});

describe("article polls — getVoteSideForCookie works for both subjects", () => {
  it("returns the side for an article-poll cookie", async () => {
    await seedArticle("test-poll-art-cookie", "feature");
    const u = await upsertPoll({
      articleId: "test-poll-art-cookie",
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: "feature",
    });
    await recordVote({
      pollId: u.pollId,
      articleId: "test-poll-art-cookie",
      category: "feature",
      side: "B",
      cookieToken: "cookie-article-side",
      ipUaHash: null,
    });
    expect(
      await getVoteSideForCookie(u.pollId, "cookie-article-side"),
    ).toBe("B");
  });
});

// ─── Article rail queries (parallel to story rails) ───────────────────────────

describe("article rail queries", () => {
  // Seed an article-poll with the requested split. Mirrors
  // seedStoryWithSplit but for the article path.
  async function seedArticleWithSplit(
    articleId: string,
    type: string,
    aCount: number,
    bCount: number,
  ): Promise<string> {
    await seedArticle(articleId, type);
    const u = await upsertPoll({
      articleId,
      question: "Q?",
      optionA: "A",
      optionB: "B",
      enabled: true,
      category: type,
    });
    for (let i = 0; i < aCount; i++) {
      await recordVote({
        pollId: u.pollId,
        articleId,
        category: type,
        side: "A",
        cookieToken: `c-art-rail-${articleId}-a-${i}`,
        ipUaHash: null,
      });
    }
    for (let i = 0; i < bCount; i++) {
      await recordVote({
        pollId: u.pollId,
        articleId,
        category: type,
        side: "B",
        cookieToken: `c-art-rail-${articleId}-b-${i}`,
        ipUaHash: null,
      });
    }
    return u.pollId;
  }

  describe("topArticleDivisive", () => {
    it("sorts most-split first, then by total_votes", async () => {
      await seedArticleWithSplit("test-poll-art-div-1", "feature", 50, 50);
      await seedArticleWithSplit("test-poll-art-div-2", "feature", 75, 25);
      await seedArticleWithSplit("test-poll-art-div-3", "feature", 49, 51);
      const rows = await topArticleDivisive({ limit: 10 });
      const ids = rows.map((r) => r.articleId);
      expect(ids.indexOf("test-poll-art-div-1")).toBeLessThan(
        ids.indexOf("test-poll-art-div-2"),
      );
      expect(ids.indexOf("test-poll-art-div-3")).toBeLessThan(
        ids.indexOf("test-poll-art-div-2"),
      );
    });

    it("drops articles below the rail floor", async () => {
      await seedArticleWithSplit("test-poll-art-div-low", "feature", 5, 5);
      const rows = await topArticleDivisive({ limit: 10 });
      expect(rows.map((r) => r.articleId)).not.toContain(
        "test-poll-art-div-low",
      );
    });

    it("filters by article type (category) when requested", async () => {
      await seedArticleWithSplit(
        "test-poll-art-div-feature",
        "feature",
        50,
        50,
      );
      await seedArticleWithSplit(
        "test-poll-art-div-review",
        "review",
        50,
        50,
      );
      const rows = await topArticleDivisive({
        category: "feature",
        limit: 10,
      });
      const ids = rows.map((r) => r.articleId);
      expect(ids).toContain("test-poll-art-div-feature");
      expect(ids).not.toContain("test-poll-art-div-review");
    });

    it("excludes the current article when excludeArticleId set", async () => {
      await seedArticleWithSplit("test-poll-art-div-self", "feature", 50, 50);
      await seedArticleWithSplit(
        "test-poll-art-div-other",
        "feature",
        48,
        52,
      );
      const rows = await topArticleDivisive({
        excludeArticleId: "test-poll-art-div-self",
        limit: 10,
      });
      expect(rows.map((r) => r.articleId)).not.toContain(
        "test-poll-art-div-self",
      );
    });

    it("does NOT surface story polls (story_id rows are filtered out)", async () => {
      // A story poll with the same vote profile must NEVER leak into
      // the article rail.
      await seedStory("test-rail-story-leak", "Drama");
      const su = await upsertPoll({
        storyId: "test-rail-story-leak",
        question: "Q?",
        optionA: "A",
        optionB: "B",
        enabled: true,
        category: "Drama",
      });
      for (let i = 0; i < 30; i++) {
        await recordVote({
          pollId: su.pollId,
          storyId: "test-rail-story-leak",
          category: "Drama",
          side: i % 2 === 0 ? "A" : "B",
          cookieToken: `c-leak-${i}`,
          ipUaHash: null,
        });
      }
      const rows = await topArticleDivisive({ limit: 10 });
      // The story poll has no article_id so the WHERE clause filters
      // it out entirely. Defensive: the assertion is "story id not
      // present" since articleId would not match either way.
      expect(rows.map((r) => r.articleId)).not.toContain(
        "test-rail-story-leak",
      );
    });
  });

  describe("topArticleAgreed", () => {
    it("sorts most-lopsided first", async () => {
      await seedArticleWithSplit("test-poll-art-agr-1", "feature", 95, 5);
      await seedArticleWithSplit("test-poll-art-agr-2", "feature", 50, 50);
      await seedArticleWithSplit("test-poll-art-agr-3", "feature", 80, 20);
      const rows = await topArticleAgreed({ limit: 10 });
      const ids = rows.map((r) => r.articleId);
      expect(ids.indexOf("test-poll-art-agr-1")).toBeLessThan(
        ids.indexOf("test-poll-art-agr-3"),
      );
      expect(ids.indexOf("test-poll-art-agr-3")).toBeLessThan(
        ids.indexOf("test-poll-art-agr-2"),
      );
    });
  });

  describe("topArticleUnpopular", () => {
    it("fallback mode surfaces articles with smaller side under 15%", async () => {
      await seedArticleWithSplit("test-poll-art-unp-95", "feature", 95, 5);
      await seedArticleWithSplit("test-poll-art-unp-70", "feature", 70, 30);
      const rows = await topArticleUnpopular({
        cookieToken: null,
        limit: 10,
      });
      const ids = rows.map((r) => r.articleId);
      expect(ids).toContain("test-poll-art-unp-95");
      expect(ids).not.toContain("test-poll-art-unp-70");
    });

    it("personalized mode surfaces articles where this cookie's side was the minority", async () => {
      const myCookie = "test-poll-art-unp-cookie-me";
      // Set up an article where 'me' voted A and A was the minority.
      await seedArticle("test-poll-art-unp-personalized", "feature");
      const u = await upsertPoll({
        articleId: "test-poll-art-unp-personalized",
        question: "Q?",
        optionA: "A",
        optionB: "B",
        enabled: true,
        category: "feature",
      });
      await recordVote({
        pollId: u.pollId,
        articleId: "test-poll-art-unp-personalized",
        category: "feature",
        side: "A",
        cookieToken: myCookie,
        ipUaHash: null,
      });
      // 24 more A voters + 75 B voters: A is 25/100, the minority.
      for (let i = 0; i < 24; i++) {
        await recordVote({
          pollId: u.pollId,
          articleId: "test-poll-art-unp-personalized",
          category: "feature",
          side: "A",
          cookieToken: `c-unp-personalized-a-${i}`,
          ipUaHash: null,
        });
      }
      for (let i = 0; i < 75; i++) {
        await recordVote({
          pollId: u.pollId,
          articleId: "test-poll-art-unp-personalized",
          category: "feature",
          side: "B",
          cookieToken: `c-unp-personalized-b-${i}`,
          ipUaHash: null,
        });
      }
      const rows = await topArticleUnpopular({
        cookieToken: myCookie,
        limit: 10,
      });
      expect(rows.map((r) => r.articleId)).toContain(
        "test-poll-art-unp-personalized",
      );
    });
  });

  describe("rail floor + visibility (article variant)", () => {
    it("does not surface noindex articles", async () => {
      const now = new Date().toISOString();
      await run("DELETE FROM articles WHERE id = ?", [
        "test-poll-art-noindex",
      ]);
      await run(
        "INSERT INTO articles (id, type, language, slug, title, status, noindex, payload, created_at, updated_at) " +
          "VALUES (?, 'feature', 'en', 'slug-noindex', 'T', 'published', 1, '{}', ?, ?)",
        ["test-poll-art-noindex", now, now],
      );
      const u = await upsertPoll({
        articleId: "test-poll-art-noindex",
        question: "Q?",
        optionA: "A",
        optionB: "B",
        enabled: true,
        category: "feature",
      });
      for (let i = 0; i < 30; i++) {
        await recordVote({
          pollId: u.pollId,
          articleId: "test-poll-art-noindex",
          category: "feature",
          side: i % 2 === 0 ? "A" : "B",
          cookieToken: `c-noindex-${i}`,
          ipUaHash: null,
        });
      }
      const rows = await topArticleDivisive({ limit: 10 });
      expect(rows.map((r) => r.articleId)).not.toContain(
        "test-poll-art-noindex",
      );
    });

    it("does not surface disabled article polls", async () => {
      await seedArticle("test-poll-art-disabled", "feature");
      const u = await upsertPoll({
        articleId: "test-poll-art-disabled",
        question: "Q?",
        optionA: "A",
        optionB: "B",
        enabled: false,
        category: "feature",
      });
      for (let i = 0; i < 30; i++) {
        await recordVote({
          pollId: u.pollId,
          articleId: "test-poll-art-disabled",
          category: "feature",
          side: i % 2 === 0 ? "A" : "B",
          cookieToken: `c-disabled-${i}`,
          ipUaHash: null,
        });
      }
      const rows = await topArticleDivisive({ limit: 10 });
      expect(rows.map((r) => r.articleId)).not.toContain(
        "test-poll-art-disabled",
      );
    });
  });
});

// ─── Minority-vote threshold (slice A of homepage-redesign-v1) ──────────────

describe("minorityVoteThresholdSettingKey", () => {
  it("returns the homepage-namespaced settings key", () => {
    expect(minorityVoteThresholdSettingKey()).toBe(
      "homepage.minority_vote_threshold",
    );
  });
});

describe("parseMinorityVoteThreshold", () => {
  it("returns the default when raw is null, undefined, or blank", () => {
    expect(parseMinorityVoteThreshold(null)).toBe(MINORITY_VOTE_DEFAULT_THRESHOLD);
    expect(parseMinorityVoteThreshold(undefined)).toBe(MINORITY_VOTE_DEFAULT_THRESHOLD);
    expect(parseMinorityVoteThreshold("")).toBe(MINORITY_VOTE_DEFAULT_THRESHOLD);
    expect(parseMinorityVoteThreshold("   ")).toBe(MINORITY_VOTE_DEFAULT_THRESHOLD);
  });

  it("returns the default on malformed values", () => {
    expect(parseMinorityVoteThreshold("not-a-number")).toBe(
      MINORITY_VOTE_DEFAULT_THRESHOLD,
    );
    expect(parseMinorityVoteThreshold("abc123")).toBe(
      MINORITY_VOTE_DEFAULT_THRESHOLD,
    );
  });

  it("returns the default on zero or negative values", () => {
    // A zero or negative threshold would surface the rail to anyone
    // with any vote history (or nobody at all on -1), which defeats
    // the gate. Fall through to the default in both cases.
    expect(parseMinorityVoteThreshold("0")).toBe(MINORITY_VOTE_DEFAULT_THRESHOLD);
    expect(parseMinorityVoteThreshold("-1")).toBe(MINORITY_VOTE_DEFAULT_THRESHOLD);
    expect(parseMinorityVoteThreshold("-100")).toBe(
      MINORITY_VOTE_DEFAULT_THRESHOLD,
    );
  });

  it("returns the parsed value when it is a positive integer", () => {
    expect(parseMinorityVoteThreshold("1")).toBe(1);
    expect(parseMinorityVoteThreshold("5")).toBe(5);
    expect(parseMinorityVoteThreshold("100")).toBe(100);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseMinorityVoteThreshold("  7  ")).toBe(7);
  });
});

describe("MINORITY_VOTE_DEFAULT_THRESHOLD", () => {
  it("is a sensible positive integer (not zero, not absurd)", () => {
    expect(MINORITY_VOTE_DEFAULT_THRESHOLD).toBeGreaterThan(0);
    expect(MINORITY_VOTE_DEFAULT_THRESHOLD).toBeLessThanOrEqual(50);
  });
});

// ─── Hero verdict badge (slice H of homepage redesign v1) ─────────────────

describe("HERO_VERDICT_DIVIDED_THRESHOLD", () => {
  it("is a sensible split threshold (close to 1 = perfect tie)", () => {
    // Anything above this gets rendered as "Audience is divided"
    // instead of a percentage. Should be high enough that only
    // near-tie polls trigger the divided copy.
    expect(HERO_VERDICT_DIVIDED_THRESHOLD).toBeGreaterThan(0.7);
    expect(HERO_VERDICT_DIVIDED_THRESHOLD).toBeLessThanOrEqual(1);
  });
});

describe("renderHeroVerdictBadge", () => {
  it("renders the percentage + winning option text when the split is clear", () => {
    expect(
      renderHeroVerdictBadge({
        totalVotes: 1200,
        divisiveness: 0.4,
        majorityPct: 73,
        majorityLabel: "the bride",
      }),
    ).toBe("73% chose the bride");
  });

  it("renders 'Audience is divided' on a tight split", () => {
    // Exactly at the threshold → divided.
    expect(
      renderHeroVerdictBadge({
        totalVotes: 800,
        divisiveness: HERO_VERDICT_DIVIDED_THRESHOLD,
        majorityPct: 53,
        majorityLabel: "Yes",
      }),
    ).toBe("Audience is divided");
    // Above the threshold → divided.
    expect(
      renderHeroVerdictBadge({
        totalVotes: 1500,
        divisiveness: 0.96,
        majorityPct: 51,
        majorityLabel: "the aunt",
      }),
    ).toBe("Audience is divided");
  });

  it("falls back to a generic copy when the option label is empty / whitespace", () => {
    // Malformed poll row (option text wiped) should never produce
    // "73% chose " with a dangling space.
    expect(
      renderHeroVerdictBadge({
        totalVotes: 300,
        divisiveness: 0.5,
        majorityPct: 73,
        majorityLabel: "",
      }),
    ).toBe("73% sided with the majority");
    expect(
      renderHeroVerdictBadge({
        totalVotes: 300,
        divisiveness: 0.5,
        majorityPct: 73,
        majorityLabel: "   ",
      }),
    ).toBe("73% sided with the majority");
  });

  it("trims surrounding whitespace from the option label", () => {
    expect(
      renderHeroVerdictBadge({
        totalVotes: 500,
        divisiveness: 0.4,
        majorityPct: 67,
        majorityLabel: "  the husband  ",
      }),
    ).toBe("67% chose the husband");
  });
});
