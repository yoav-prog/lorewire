// Tests for the engagement-poll storage helpers + pure math. The DB
// tests use the real SQLite seam (same pattern as homepage-curation
// tests) and reset both tables before each case so they stay
// independent. Pure-function tests run without touching the DB.
//
// Plan: _plans/2026-06-17-engagement-polls.md.

import { beforeEach, describe, expect, it } from "vitest";
import { run } from "@/lib/db";
import {
  CATEGORY_POLL_PRESETS,
  DEFAULT_PUBLIC_FLOOR,
  divisiveness,
  getAggregateByStoryId,
  getPollByStoryId,
  getPresetForCategory,
  getVoteSideForCookie,
  HOMEPAGE_RAIL_LIMIT,
  isPollSide,
  isRailEnabledValue,
  listPollOverview,
  pctA,
  pctBComplement,
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  POLL_RAIL_KINDS,
  railEnabledSettingKey,
  RAIL_MIN_VOTES,
  recordVote,
  refreshPollAggregateForStory,
  toResultView,
  topAgreed,
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
