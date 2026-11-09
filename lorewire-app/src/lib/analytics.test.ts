// Tests for the admin analytics query layer. DB tests use the real
// SQLite seam (tests/setup.ts points lib/db.ts at a per-run temp file,
// same pattern as polls.test.ts). Every query takes an explicit `now`
// pinned in January 2030, and the seeded rows live in that window — rows
// other test files write with the real clock (2026) can never leak into
// a windowed assertion. story_events and comments are cleared fully in
// beforeEach (they have no other cross-file test owner that pre-seeds).
//
// Plan: _plans/2026-07-05-admin-analytics.md.

import { beforeEach, describe, expect, it } from "vitest";
import { run } from "@/lib/db";
import {
  enumerateDaysUtc,
  getAnalyticsOverview,
  getCategoryBreakdown,
  getDailySeries,
  getPollInsights,
  getPublishingStats,
  getStoryAnalytics,
  getStoryPerformance,
  parseAnalyticsRange,
  previousWindowIso,
  rangeCutoffIso,
  POLL_SPOTLIGHT_MIN_VOTES,
} from "@/lib/analytics";

// Pinned "today" for every windowed query: 2030-01-31 noon UTC.
const NOW = new Date("2030-01-31T12:00:00.000Z");

/** ISO instant `days` before NOW (same wall time). */
function daysAgo(days: number, hour = "06:00:00"): string {
  const d = new Date(NOW.getTime() - days * 86_400_000);
  return `${d.toISOString().slice(0, 10)}T${hour}.000Z`;
}

let seq = 0;
function id(prefix: string): string {
  seq += 1;
  return `test-anl-${prefix}-${seq}`;
}

async function insertStory(args: {
  id: string;
  title?: string;
  category?: string;
  status?: string;
  publishedAt?: string | null;
}): Promise<void> {
  await run(
    `INSERT INTO stories (id, title, category, status, published_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      args.title ?? args.id,
      args.category ?? "Drama",
      args.status ?? "published",
      args.publishedAt ?? daysAgo(20),
      daysAgo(25),
    ],
  );
}

async function insertEvent(args: {
  storyId: string;
  type: string;
  occurredAt: string;
  anonId?: string | null;
  weight?: number;
}): Promise<void> {
  await run(
    `INSERT INTO story_events (id, story_id, event_type, anon_id, occurred_at, weight)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id("ev"),
      args.storyId,
      args.type,
      args.anonId === undefined ? "anon-1" : args.anonId,
      args.occurredAt,
      args.weight ?? 0.05,
    ],
  );
}

async function reset(): Promise<void> {
  await run("DELETE FROM story_events WHERE 1=1");
  await run("DELETE FROM comments WHERE 1=1");
  await run("DELETE FROM stories WHERE id LIKE 'test-anl-%'");
  await run("DELETE FROM articles WHERE id LIKE 'test-anl-%'");
  await run("DELETE FROM users WHERE id LIKE 'test-anl-%'");
  await run("DELETE FROM polls WHERE id LIKE 'test-anl-%'");
  await run("DELETE FROM poll_votes WHERE id LIKE 'test-anl-%'");
  await run("DELETE FROM poll_aggregates WHERE story_id LIKE 'test-anl-%'");
  await run("DELETE FROM user_saves WHERE id LIKE 'test-anl-%'");
  await run("DELETE FROM user_likes WHERE id LIKE 'test-anl-%'");
  await run("DELETE FROM youtube_posts WHERE id LIKE 'test-anl-%'");
  await run("DELETE FROM facebook_posts WHERE id LIKE 'test-anl-%'");
}

beforeEach(reset);

// ---------------------------------------------------------------------------
// Pure window math

describe("parseAnalyticsRange", () => {
  it("accepts exactly the closed enum", () => {
    expect(parseAnalyticsRange("7")).toBe(7);
    expect(parseAnalyticsRange("30")).toBe(30);
    expect(parseAnalyticsRange("90")).toBe(90);
    expect(parseAnalyticsRange("all")).toBe("all");
  });

  it("falls back to 30 for anything else", () => {
    expect(parseAnalyticsRange(undefined)).toBe(30);
    expect(parseAnalyticsRange("999")).toBe(30);
    expect(parseAnalyticsRange("7; DROP TABLE stories")).toBe(30);
    expect(parseAnalyticsRange(["7", "30"])).toBe(30);
  });
});

describe("rangeCutoffIso / previousWindowIso", () => {
  it("cuts off exactly N days back", () => {
    expect(rangeCutoffIso(7, NOW)).toBe("2030-01-24T12:00:00.000Z");
    expect(rangeCutoffIso("all", NOW)).toBeNull();
  });

  it("previous window sits immediately before the current one", () => {
    expect(previousWindowIso(7, NOW)).toEqual({
      from: "2030-01-17T12:00:00.000Z",
      to: "2030-01-24T12:00:00.000Z",
    });
    expect(previousWindowIso("all", NOW)).toBeNull();
  });
});

describe("enumerateDaysUtc", () => {
  it("is inclusive on both ends", () => {
    expect(enumerateDaysUtc("2030-01-30", "2030-02-01")).toEqual([
      "2030-01-30",
      "2030-01-31",
      "2030-02-01",
    ]);
    expect(enumerateDaysUtc("2030-01-31", "2030-01-31")).toEqual(["2030-01-31"]);
  });

  it("returns [] for inverted or malformed ranges", () => {
    expect(enumerateDaysUtc("2030-02-01", "2030-01-30")).toEqual([]);
    expect(enumerateDaysUtc("garbage", "2030-01-30")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Overview KPIs

describe("getAnalyticsOverview", () => {
  it("counts events, viewers, comments and members in the window", async () => {
    const story = id("story");
    await insertStory({ id: story });
    await insertEvent({ storyId: story, type: "play_started", occurredAt: daysAgo(1), anonId: "a1" });
    await insertEvent({ storyId: story, type: "play_started", occurredAt: daysAgo(2), anonId: "a2" });
    await insertEvent({ storyId: story, type: "play_completed", occurredAt: daysAgo(1), anonId: "a1" });
    await insertEvent({ storyId: story, type: "poll_vote", occurredAt: daysAgo(3), anonId: "a1" });
    // Outside the 7-day window: must not count.
    await insertEvent({ storyId: story, type: "play_started", occurredAt: daysAgo(10), anonId: "a3" });

    const article = id("article");
    await run(
      `INSERT INTO articles (id, title, status, story_id, created_at) VALUES (?, ?, 'published', ?, ?)`,
      [article, "Article", story, daysAgo(2)],
    );
    await run(
      `INSERT INTO comments (id, article_id, body, status, created_at) VALUES (?, ?, 'hi', 'published', ?)`,
      [id("comment"), article, daysAgo(1)],
    );
    await run(
      `INSERT INTO users (id, email, provider, provider_sub, created_at) VALUES (?, ?, 'google', ?, ?)`,
      [id("user"), "anl@example.com", "sub-1", daysAgo(2)],
    );

    const overview = await getAnalyticsOverview(7, NOW);
    expect(overview.current.plays).toBe(2);
    expect(overview.current.completions).toBe(1);
    expect(overview.current.pollVotes).toBe(1);
    expect(overview.current.totalEvents).toBe(4);
    expect(overview.current.uniqueViewers).toBe(2);
    expect(overview.current.comments).toBe(1);
    expect(overview.current.newMembers).toBe(1);
    // The 10-days-ago play lands in the previous window instead.
    expect(overview.previous?.plays).toBe(1);
  });

  it("has no previous window for all-time", async () => {
    const overview = await getAnalyticsOverview("all", NOW);
    expect(overview.previous).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Daily series

describe("getDailySeries", () => {
  it("zero-fills every day of the window and buckets by UTC day", async () => {
    const story = id("story");
    await insertStory({ id: story });
    await insertEvent({ storyId: story, type: "play_started", occurredAt: daysAgo(0), anonId: "a1" });
    await insertEvent({ storyId: story, type: "play_started", occurredAt: daysAgo(0), anonId: "a2" });
    await insertEvent({ storyId: story, type: "save_added", occurredAt: daysAgo(3), anonId: "a1" });

    const series = await getDailySeries(7, NOW);
    expect(series.days).toHaveLength(7);
    expect(series.days[6]).toBe("2030-01-31");
    expect(series.counts.play_started[6]).toBe(2);
    expect(series.counts.save_added[3]).toBe(1);
    // Untouched days stay zero, not undefined.
    expect(series.counts.play_completed.every((v) => v === 0)).toBe(true);
    expect(series.viewers[6]).toBe(2);
    expect(series.viewers[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Category breakdown

describe("getCategoryBreakdown", () => {
  it("groups events by the story's category", async () => {
    const drama = id("story");
    const humor = id("story");
    await insertStory({ id: drama, category: "Drama" });
    await insertStory({ id: humor, category: "Humor" });
    await insertEvent({ storyId: drama, type: "play_started", occurredAt: daysAgo(1) });
    await insertEvent({ storyId: drama, type: "play_completed", occurredAt: daysAgo(1) });
    await insertEvent({ storyId: humor, type: "poll_vote", occurredAt: daysAgo(1) });

    const slices = await getCategoryBreakdown(7, NOW);
    const dramaSlice = slices.find((s) => s.category === "Drama");
    const humorSlice = slices.find((s) => s.category === "Humor");
    expect(dramaSlice).toMatchObject({ plays: 1, completions: 1, events: 2 });
    expect(humorSlice).toMatchObject({ votes: 1, events: 1 });
  });
});

// ---------------------------------------------------------------------------
// Story performance table

describe("getStoryPerformance", () => {
  it("rolls up per-story engagement with completion rate", async () => {
    const hot = id("story");
    const cold = id("story");
    await insertStory({ id: hot, title: "Hot story" });
    await insertStory({ id: cold, title: "Cold story" });
    await insertEvent({ storyId: hot, type: "play_started", occurredAt: daysAgo(1), anonId: "a1", weight: 0.05 });
    await insertEvent({ storyId: hot, type: "play_started", occurredAt: daysAgo(2), anonId: "a2", weight: 0.05 });
    await insertEvent({ storyId: hot, type: "play_completed", occurredAt: daysAgo(1), anonId: "a1", weight: 0.45 });

    const rows = await getStoryPerformance(7, 500, NOW);
    const hotRow = rows.find((r) => r.id === hot);
    const coldRow = rows.find((r) => r.id === cold);

    expect(hotRow).toMatchObject({ plays: 2, completions: 1, viewers: 2 });
    expect(hotRow?.completionRate).toBeCloseTo(0.5);
    expect(hotRow?.score).toBeCloseTo(0.55);
    // Published story with zero events still appears, with a null rate.
    expect(coldRow).toMatchObject({ plays: 0, score: 0 });
    expect(coldRow?.completionRate).toBeNull();
    // Engaged stories sort above silent ones.
    expect(rows.indexOf(hotRow!)).toBeLessThan(rows.indexOf(coldRow!));
  });

  it("excludes drafts without events but keeps drafts with events", async () => {
    const silentDraft = id("story");
    const activeDraft = id("story");
    await insertStory({ id: silentDraft, status: "draft" });
    await insertStory({ id: activeDraft, status: "draft" });
    await insertEvent({ storyId: activeDraft, type: "play_started", occurredAt: daysAgo(1) });

    const rows = await getStoryPerformance(7, 500, NOW);
    expect(rows.find((r) => r.id === silentDraft)).toBeUndefined();
    expect(rows.find((r) => r.id === activeDraft)).toBeDefined();
  });

  it("only counts events inside the window", async () => {
    const story = id("story");
    await insertStory({ id: story });
    await insertEvent({ storyId: story, type: "play_started", occurredAt: daysAgo(10) });

    const rows = await getStoryPerformance(7, 500, NOW);
    expect(rows.find((r) => r.id === story)?.plays).toBe(0);

    const allRows = await getStoryPerformance("all", 500, NOW);
    expect(allRows.find((r) => r.id === story)?.plays).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Poll insights

describe("getPollInsights", () => {
  it("ranks polls by votes in the window and respects the spotlight floor", async () => {
    const story = id("story");
    await insertStory({ id: story, title: "Poll story" });
    const poll = id("poll");
    await run(
      `INSERT INTO polls (id, story_id, question, option_a_text, option_b_text, enabled, created_at)
       VALUES (?, ?, 'Who is right?', 'Her', 'Him', 1, ?)`,
      [poll, story, daysAgo(5)],
    );
    for (let i = 0; i < 3; i++) {
      await run(
        `INSERT INTO poll_votes (id, poll_id, story_id, side, cookie_token, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id("vote"), poll, story, i < 2 ? "A" : "B", `tok-${i}`, daysAgo(1)],
      );
    }
    // Aggregate above the floor -> spotlight eligible.
    await run(
      `INSERT INTO poll_aggregates (story_id, poll_id, votes_a, votes_b, total_votes, divisiveness, agreement, last_vote_at, refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [story, poll, 6, 6, 12, 1.0, 0.0, daysAgo(1), daysAgo(1)],
    );

    const insights = await getPollInsights(7, NOW);
    expect(insights.votesInRange).toBe(3);
    expect(insights.pollsVotedInRange).toBe(1);
    const leader = insights.topVoted.find((p) => p.pollId === poll);
    expect(leader).toMatchObject({ votes: 3, votesA: 2, subjectTitle: "Poll story" });
    expect(
      insights.mostDivisive.find((s) => s.storyId === story),
    ).toBeDefined();
  });

  it("keeps under-floor polls out of the spotlights", async () => {
    const story = id("story");
    await insertStory({ id: story });
    const poll = id("poll");
    await run(
      `INSERT INTO polls (id, story_id, question, option_a_text, option_b_text, enabled, created_at)
       VALUES (?, ?, 'Q', 'A', 'B', 1, ?)`,
      [poll, story, daysAgo(5)],
    );
    await run(
      `INSERT INTO poll_aggregates (story_id, poll_id, votes_a, votes_b, total_votes, divisiveness, agreement, last_vote_at, refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [story, poll, 2, 2, POLL_SPOTLIGHT_MIN_VOTES - 1, 1.0, 0.0, daysAgo(1), daysAgo(1)],
    );

    const insights = await getPollInsights(7, NOW);
    expect(insights.mostDivisive.find((s) => s.storyId === story)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Publishing stats

describe("getPublishingStats", () => {
  it("splits posted / failed / pending and skips soft-deleted rows", async () => {
    const story = id("story");
    await insertStory({ id: story });
    const insertYt = (postId: string, status: string, postedAt: string | null, deletedAt: string | null) =>
      run(
        `INSERT INTO youtube_posts (id, story_id, status, posted_at, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [postId, story, status, postedAt, daysAgo(2), deletedAt],
      );
    await insertYt(id("yt"), "posted", daysAgo(2), null);
    await insertYt(id("yt"), "failed", null, null);
    await insertYt(id("yt"), "pending", null, null);
    await insertYt(id("yt"), "posted", daysAgo(2), daysAgo(1)); // soft-deleted

    const stats = await getPublishingStats(7, NOW);
    const yt = stats.find((s) => s.platform === "youtube");
    expect(yt).toMatchObject({ total: 3, posted: 1, failed: 1, pending: 1 });
  });
});

// ---------------------------------------------------------------------------
// Per-story drilldown

describe("getStoryAnalytics", () => {
  it("returns null for an unknown story", async () => {
    expect(await getStoryAnalytics("test-anl-nope", 7, NOW)).toBeNull();
  });

  it("assembles the full drilldown for one story", async () => {
    const story = id("story");
    await insertStory({ id: story, title: "Deep dive", category: "Dating" });
    await insertEvent({ storyId: story, type: "play_started", occurredAt: daysAgo(1), anonId: "a1" });
    await insertEvent({ storyId: story, type: "play_completed", occurredAt: daysAgo(1), anonId: "a1" });
    // Out of window, still in all-time.
    await insertEvent({ storyId: story, type: "play_started", occurredAt: daysAgo(40), anonId: "a2" });
    // A different story's events must not bleed in.
    const other = id("story");
    await insertStory({ id: other });
    await insertEvent({ storyId: other, type: "play_started", occurredAt: daysAgo(1) });

    const poll = id("poll");
    await run(
      `INSERT INTO polls (id, story_id, question, option_a_text, option_b_text, enabled, created_at)
       VALUES (?, ?, 'Fair?', 'Yes', 'No', 1, ?)`,
      [poll, story, daysAgo(5)],
    );
    await run(
      `INSERT INTO poll_aggregates (story_id, poll_id, votes_a, votes_b, total_votes, divisiveness, agreement, last_vote_at, refreshed_at)
       VALUES (?, ?, 8, 4, 12, 0.66, 0.34, ?, ?)`,
      [story, poll, daysAgo(1), daysAgo(1)],
    );
    await run(
      `INSERT INTO poll_votes (id, poll_id, story_id, side, cookie_token, created_at)
       VALUES (?, ?, ?, 'A', 'tok-x', ?)`,
      [id("vote"), poll, story, daysAgo(1)],
    );
    await run(
      `INSERT INTO user_saves (id, user_id, story_id, created_at) VALUES (?, 'u1', ?, ?)`,
      [id("save"), story, daysAgo(1)],
    );
    const article = id("article");
    await run(
      `INSERT INTO articles (id, title, status, story_id, created_at) VALUES (?, 'A', 'published', ?, ?)`,
      [article, story, daysAgo(3)],
    );
    await run(
      `INSERT INTO comments (id, article_id, body, status, created_at) VALUES (?, ?, 'nice', 'published', ?)`,
      [id("comment"), article, daysAgo(1)],
    );
    await run(
      `INSERT INTO facebook_posts (id, story_id, status, "trigger", posted_at, created_at)
       VALUES (?, ?, 'posted', 'auto', ?, ?)`,
      [id("fb"), story, daysAgo(1), daysAgo(1)],
    );

    const data = await getStoryAnalytics(story, 7, NOW);
    expect(data).not.toBeNull();
    expect(data!.story).toMatchObject({ id: story, title: "Deep dive", category: "Dating" });
    expect(data!.totals.play_started).toBe(1);
    expect(data!.allTime.play_started).toBe(2);
    expect(data!.viewers).toBe(1);
    expect(data!.daily.days).toHaveLength(7);
    expect(data!.daily.counts.play_started[6]).toBe(0);
    expect(data!.daily.counts.play_started[5]).toBe(1);
    expect(data!.poll).toMatchObject({
      question: "Fair?",
      votesA: 8,
      votesB: 4,
      totalVotes: 12,
      votesInRange: 1,
      enabled: true,
    });
    expect(data!.memberSaves).toBe(1);
    expect(data!.comments).toEqual({ total: 1, published: 1 });
    expect(data!.posts).toHaveLength(1);
    expect(data!.posts[0]).toMatchObject({ platform: "facebook", trigger: "auto" });
  });
});
