// Read-only query layer for the /admin/analytics dashboard
// (_plans/2026-07-05-admin-analytics.md). Everything here reads tables the
// site already writes — story_events (consent-gated anonymous engagement,
// lib/story-events.ts), poll_votes / poll_aggregates, comments, users, and
// the four social publish logs. No mutations, no new tables, no cron.
//
// Portability contract (same as lib/db.ts): every query runs unchanged on
// SQLite and Postgres. Day bucketing is substr(<ISO text>, 1, 10), window
// filtering is ISO-string comparison, and every COUNT/SUM goes through
// num() because the Postgres driver returns bigint aggregates as strings.
//
// Rule 14: every public reader logs one `[lorewire analytics]` line with
// the function, window, row count and duration, so a slow dashboard is
// diagnosable from the server log alone.

import "server-only";

import { all } from "@/lib/db";
import {
  type AnalyticsRange,
  type StoryPerformanceRow,
} from "@/lib/analytics-shared";
import { resolveMediaUrl } from "@/lib/media-url";
import type { StoryEventType } from "@/lib/story-events";

// Client-safe surface (range enum, param parsing, table row type) lives in
// lib/analytics-shared.ts; re-exported here so server code has one import.
export {
  ANALYTICS_RANGES,
  parseAnalyticsRange,
  type AnalyticsRange,
  type StoryPerformanceRow,
} from "@/lib/analytics-shared";

// ---------------------------------------------------------------------------
// Pure window math (exported for unit tests)

/** ISO instant `range` days before `now`; null means "no lower bound". */
export function rangeCutoffIso(
  range: AnalyticsRange,
  now: Date,
): string | null {
  if (range === "all") return null;
  return new Date(now.getTime() - range * 86_400_000).toISOString();
}

/** The window immediately before the current one, for delta KPIs
 *  ("plays vs the previous 30 days"). "all" has no previous window. */
export function previousWindowIso(
  range: AnalyticsRange,
  now: Date,
): { from: string; to: string } | null {
  if (range === "all") return null;
  const to = new Date(now.getTime() - range * 86_400_000);
  const from = new Date(now.getTime() - 2 * range * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Inclusive list of YYYY-MM-DD days from `fromDay` to `toDay` (UTC).
 *  Used to zero-fill chart series so gaps render as 0, not as skipped
 *  x-positions. Returns [] when the range is inverted or malformed. */
export function enumerateDaysUtc(fromDay: string, toDay: string): string[] {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return [];
  const days: string[] = [];
  for (let t = from; t <= to; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

// ---------------------------------------------------------------------------
// Shared internals

/** Mirrors StoryEventType in lib/story-events.ts. Kept as a local literal
 *  (type-checked against the imported type) instead of importing the
 *  runtime module, which drags next/headers into every consumer. */
export const STORY_EVENT_TYPES = [
  "play_started",
  "play_completed",
  "save_added",
  "rating_submitted",
  "poll_vote",
  "share_initiated",
] as const satisfies readonly StoryEventType[];

// Compile-time exhaustiveness: adding a new StoryEventType without listing
// it above turns this alias into `never` and fails the build.
type _AllEventTypesListed = Exclude<
  StoryEventType,
  (typeof STORY_EVENT_TYPES)[number]
> extends never
  ? true
  : never;
const _allEventTypesListed: _AllEventTypesListed = true;
void _allEventTypesListed;

/** Postgres returns bigint aggregates as strings; SQLite returns numbers.
 *  Every aggregate read goes through here. */
function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Build "col >= ? AND col < ?" fragments for a [from, to) window where
 *  either bound may be absent. Returns conds to AND together + params in
 *  matching order. */
function windowConds(
  col: string,
  from: string | null,
  to: string | null,
): { conds: string[]; params: string[] } {
  const conds: string[] = [];
  const params: string[] = [];
  if (from) {
    conds.push(`${col} >= ?`);
    params.push(from);
  }
  if (to) {
    conds.push(`${col} < ?`);
    params.push(to);
  }
  return { conds, params };
}

function where(conds: string[]): string {
  return conds.length > 0 ? ` WHERE ${conds.join(" AND ")}` : "";
}

function logQuery(fn: string, range: AnalyticsRange, startedAt: number, rows: number): void {
  console.info("[lorewire analytics]", {
    fn,
    range,
    ms: Date.now() - startedAt,
    rows,
  });
}

// ---------------------------------------------------------------------------
// Overview KPIs

export interface OverviewKpis {
  plays: number;
  completions: number;
  pollVotes: number;
  saves: number;
  shares: number;
  ratings: number;
  totalEvents: number;
  uniqueViewers: number;
  comments: number;
  newMembers: number;
}

export interface AnalyticsOverview {
  range: AnalyticsRange;
  current: OverviewKpis;
  /** null when range is "all" (no previous window to compare against). */
  previous: OverviewKpis | null;
}

async function kpisForWindow(
  from: string | null,
  to: string | null,
): Promise<OverviewKpis> {
  const events = windowConds("occurred_at", from, to);
  const created = windowConds("created_at", from, to);

  const [byType, viewers, comments, members] = await Promise.all([
    all(
      `SELECT event_type AS t, COUNT(*) AS n FROM story_events${where(events.conds)} GROUP BY event_type`,
      events.params,
    ),
    all(
      `SELECT COUNT(DISTINCT anon_id) AS n FROM story_events${where([
        "anon_id IS NOT NULL",
        ...events.conds,
      ])}`,
      events.params,
    ),
    all(`SELECT COUNT(*) AS n FROM comments${where(created.conds)}`, created.params),
    all(
      `SELECT COUNT(*) AS n FROM users${where([
        "provider IS NOT NULL",
        ...created.conds,
      ])}`,
      created.params,
    ),
  ]);

  const counts: Record<string, number> = {};
  let totalEvents = 0;
  for (const row of byType) {
    const n = num(row.n);
    counts[String(row.t)] = n;
    totalEvents += n;
  }

  return {
    plays: counts.play_started ?? 0,
    completions: counts.play_completed ?? 0,
    pollVotes: counts.poll_vote ?? 0,
    saves: counts.save_added ?? 0,
    shares: counts.share_initiated ?? 0,
    ratings: counts.rating_submitted ?? 0,
    totalEvents,
    uniqueViewers: num(viewers[0]?.n),
    comments: num(comments[0]?.n),
    newMembers: num(members[0]?.n),
  };
}

export async function getAnalyticsOverview(
  range: AnalyticsRange,
  now: Date = new Date(),
): Promise<AnalyticsOverview> {
  const startedAt = Date.now();
  const cutoff = rangeCutoffIso(range, now);
  const prev = previousWindowIso(range, now);

  const [current, previous] = await Promise.all([
    kpisForWindow(cutoff, null),
    prev ? kpisForWindow(prev.from, prev.to) : Promise.resolve(null),
  ]);

  logQuery("getAnalyticsOverview", range, startedAt, 1);
  return { range, current, previous };
}

// ---------------------------------------------------------------------------
// Daily series (trend charts)

export interface DailySeries {
  /** YYYY-MM-DD ascending; every day in the window, zero-filled. */
  days: string[];
  counts: Record<StoryEventType, number[]>;
  /** Distinct anon viewers per day. */
  viewers: number[];
}

/** "all" charts are capped at the trailing year so an old site still
 *  renders a readable x-axis. */
const ALL_TIME_CHART_DAYS = 365;

function emptyDailySeries(days: string[]): DailySeries {
  const counts = Object.fromEntries(
    STORY_EVENT_TYPES.map((t) => [t, days.map(() => 0)]),
  ) as Record<StoryEventType, number[]>;
  return { days, counts, viewers: days.map(() => 0) };
}

async function dailySeriesForConds(
  range: AnalyticsRange,
  now: Date,
  extraConds: string[],
  extraParams: string[],
  fnLabel: string,
): Promise<DailySeries> {
  const startedAt = Date.now();
  const today = now.toISOString().slice(0, 10);

  let fromDay: string;
  if (range === "all") {
    const oldest = await all(
      `SELECT MIN(substr(occurred_at, 1, 10)) AS d FROM story_events${where(extraConds)}`,
      extraParams,
    );
    const floor = new Date(now.getTime() - (ALL_TIME_CHART_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const min = str(oldest[0]?.d);
    fromDay = min && min > floor ? min : floor;
  } else {
    fromDay = new Date(now.getTime() - (range - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
  }

  const days = enumerateDaysUtc(fromDay, today);
  const series = emptyDailySeries(days);
  const index = new Map(days.map((d, i) => [d, i]));
  const conds = [`substr(occurred_at, 1, 10) >= ?`, ...extraConds];
  const params = [fromDay, ...extraParams];

  const [byDayType, viewersByDay] = await Promise.all([
    all(
      `SELECT substr(occurred_at, 1, 10) AS d, event_type AS t, COUNT(*) AS n
       FROM story_events${where(conds)}
       GROUP BY 1, 2 ORDER BY 1`,
      params,
    ),
    all(
      `SELECT substr(occurred_at, 1, 10) AS d, COUNT(DISTINCT anon_id) AS n
       FROM story_events${where(["anon_id IS NOT NULL", ...conds])}
       GROUP BY 1 ORDER BY 1`,
      params,
    ),
  ]);

  for (const row of byDayType) {
    const i = index.get(String(row.d));
    const type = String(row.t) as StoryEventType;
    if (i === undefined || !(type in series.counts)) continue;
    series.counts[type][i] = num(row.n);
  }
  for (const row of viewersByDay) {
    const i = index.get(String(row.d));
    if (i === undefined) continue;
    series.viewers[i] = num(row.n);
  }

  logQuery(fnLabel, range, startedAt, byDayType.length);
  return series;
}

export async function getDailySeries(
  range: AnalyticsRange,
  now: Date = new Date(),
): Promise<DailySeries> {
  return dailySeriesForConds(range, now, [], [], "getDailySeries");
}

// ---------------------------------------------------------------------------
// Category breakdown

export interface CategorySlice {
  category: string;
  plays: number;
  completions: number;
  votes: number;
  saves: number;
  events: number;
  score: number;
}

export async function getCategoryBreakdown(
  range: AnalyticsRange,
  now: Date = new Date(),
): Promise<CategorySlice[]> {
  const startedAt = Date.now();
  const win = windowConds("e.occurred_at", rangeCutoffIso(range, now), null);

  const rows = await all(
    `SELECT COALESCE(s.category, 'Uncategorized') AS category,
            COUNT(*) AS events,
            SUM(CASE WHEN e.event_type = 'play_started' THEN 1 ELSE 0 END) AS plays,
            SUM(CASE WHEN e.event_type = 'play_completed' THEN 1 ELSE 0 END) AS completions,
            SUM(CASE WHEN e.event_type = 'poll_vote' THEN 1 ELSE 0 END) AS votes,
            SUM(CASE WHEN e.event_type = 'save_added' THEN 1 ELSE 0 END) AS saves,
            COALESCE(SUM(e.weight), 0) AS score
     FROM story_events e
     LEFT JOIN stories s ON s.id = e.story_id${where(win.conds)}
     GROUP BY 1 ORDER BY events DESC`,
    win.params,
  );

  logQuery("getCategoryBreakdown", range, startedAt, rows.length);
  return rows.map((r) => ({
    category: String(r.category),
    plays: num(r.plays),
    completions: num(r.completions),
    votes: num(r.votes),
    saves: num(r.saves),
    events: num(r.events),
    score: num(r.score),
  }));
}

// ---------------------------------------------------------------------------
// Story performance (the searchable table)

/** Public-facing stories (published/ready) plus any story that saw events
 *  in the window, each with its per-window engagement rollup. The page's
 *  table searches and sorts this list client-side, so the cap is a safety
 *  net, not pagination. */
export async function getStoryPerformance(
  range: AnalyticsRange,
  limit = 500,
  now: Date = new Date(),
): Promise<StoryPerformanceRow[]> {
  const startedAt = Date.now();
  const cutoff = rangeCutoffIso(range, now);
  const joinWindow = cutoff ? " AND e.occurred_at >= ?" : "";
  const params: unknown[] = cutoff ? [cutoff] : [];
  params.push(limit);

  const rows = await all(
    `SELECT s.id, s.title, s.category, s.status, s.published_at, s.duration,
            s.thumbnail_image,
            SUM(CASE WHEN e.event_type = 'play_started' THEN 1 ELSE 0 END) AS plays,
            SUM(CASE WHEN e.event_type = 'play_completed' THEN 1 ELSE 0 END) AS completions,
            SUM(CASE WHEN e.event_type = 'poll_vote' THEN 1 ELSE 0 END) AS votes,
            SUM(CASE WHEN e.event_type = 'save_added' THEN 1 ELSE 0 END) AS saves,
            SUM(CASE WHEN e.event_type = 'share_initiated' THEN 1 ELSE 0 END) AS shares,
            SUM(CASE WHEN e.event_type = 'rating_submitted' THEN 1 ELSE 0 END) AS ratings,
            COALESCE(SUM(e.weight), 0) AS score,
            COUNT(DISTINCT e.anon_id) AS viewers
     FROM stories s
     LEFT JOIN story_events e ON e.story_id = s.id${joinWindow}
     WHERE s.status IN ('published', 'ready') OR e.id IS NOT NULL
     GROUP BY s.id, s.title, s.category, s.status, s.published_at, s.duration,
              s.thumbnail_image
     ORDER BY score DESC, plays DESC, s.published_at DESC
     LIMIT ?`,
    params,
  );

  logQuery("getStoryPerformance", range, startedAt, rows.length);
  return rows.map((r) => {
    const plays = num(r.plays);
    const completions = num(r.completions);
    return {
      id: String(r.id),
      title: str(r.title) ?? String(r.id),
      category: str(r.category),
      status: str(r.status),
      publishedAt: str(r.published_at),
      duration: str(r.duration),
      thumbnail: resolveMediaUrl(str(r.thumbnail_image)),
      plays,
      completions,
      completionRate: plays > 0 ? completions / plays : null,
      viewers: num(r.viewers),
      votes: num(r.votes),
      saves: num(r.saves),
      shares: num(r.shares),
      ratings: num(r.ratings),
      score: num(r.score),
    };
  });
}

// ---------------------------------------------------------------------------
// Poll insights

/** Spotlight lists (most divisive / most agreed) only consider polls with
 *  at least this many all-time votes, so a 2-vote poll can't rank as
 *  "perfectly split". */
export const POLL_SPOTLIGHT_MIN_VOTES = 10;

export interface PollLeader {
  pollId: string;
  question: string;
  optionA: string;
  optionB: string;
  storyId: string | null;
  articleId: string | null;
  subjectTitle: string | null;
  votes: number;
  votesA: number;
}

export interface PollSpotlight {
  storyId: string;
  title: string | null;
  question: string;
  totalVotes: number;
  votesA: number;
  votesB: number;
  divisiveness: number;
}

export interface PollInsights {
  votesInRange: number;
  pollsVotedInRange: number;
  topVoted: PollLeader[];
  mostDivisive: PollSpotlight[];
  mostAgreed: PollSpotlight[];
}

export async function getPollInsights(
  range: AnalyticsRange,
  now: Date = new Date(),
): Promise<PollInsights> {
  const startedAt = Date.now();
  const win = windowConds("v.created_at", rangeCutoffIso(range, now), null);

  const spotlightSql = (order: "DESC" | "ASC") =>
    `SELECT g.story_id, g.total_votes, g.votes_a, g.votes_b, g.divisiveness,
            s.title, p.question
     FROM poll_aggregates g
     JOIN polls p ON p.id = g.poll_id
     LEFT JOIN stories s ON s.id = g.story_id
     WHERE g.total_votes >= ?
     ORDER BY g.divisiveness ${order}, g.total_votes DESC
     LIMIT 5`;

  const [totals, topVoted, divisive, agreed] = await Promise.all([
    all(
      `SELECT COUNT(*) AS votes, COUNT(DISTINCT v.poll_id) AS polls
       FROM poll_votes v${where(win.conds)}`,
      win.params,
    ),
    all(
      `SELECT v.poll_id, p.question, p.option_a_text, p.option_b_text,
              p.story_id, p.article_id,
              COALESCE(s.title, a.title) AS subject_title,
              COUNT(*) AS votes,
              SUM(CASE WHEN v.side = 'A' THEN 1 ELSE 0 END) AS votes_a
       FROM poll_votes v
       JOIN polls p ON p.id = v.poll_id
       LEFT JOIN stories s ON s.id = p.story_id
       LEFT JOIN articles a ON a.id = p.article_id${where(win.conds)}
       GROUP BY v.poll_id, p.question, p.option_a_text, p.option_b_text,
                p.story_id, p.article_id, s.title, a.title
       ORDER BY votes DESC LIMIT 8`,
      win.params,
    ),
    all(spotlightSql("DESC"), [POLL_SPOTLIGHT_MIN_VOTES]),
    all(spotlightSql("ASC"), [POLL_SPOTLIGHT_MIN_VOTES]),
  ]);

  const toSpotlight = (r: Record<string, unknown>): PollSpotlight => ({
    storyId: String(r.story_id),
    title: str(r.title),
    question: str(r.question) ?? "",
    totalVotes: num(r.total_votes),
    votesA: num(r.votes_a),
    votesB: num(r.votes_b),
    divisiveness: num(r.divisiveness),
  });

  const insights: PollInsights = {
    votesInRange: num(totals[0]?.votes),
    pollsVotedInRange: num(totals[0]?.polls),
    topVoted: topVoted.map((r) => ({
      pollId: String(r.poll_id),
      question: str(r.question) ?? "",
      optionA: str(r.option_a_text) ?? "A",
      optionB: str(r.option_b_text) ?? "B",
      storyId: str(r.story_id),
      articleId: str(r.article_id),
      subjectTitle: str(r.subject_title),
      votes: num(r.votes),
      votesA: num(r.votes_a),
    })),
    mostDivisive: divisive.map(toSpotlight),
    mostAgreed: agreed.map(toSpotlight),
  };

  logQuery("getPollInsights", range, startedAt, topVoted.length);
  return insights;
}

// ---------------------------------------------------------------------------
// Social publishing

export type PublishPlatform = "youtube" | "facebook" | "instagram" | "tiktok";

export interface PlatformPublishStats {
  platform: PublishPlatform;
  total: number;
  posted: number;
  failed: number;
  pending: number;
  lastPostedAt: string | null;
}

/** Table-per-platform, all sharing status / posted_at / created_at /
 *  deleted_at columns. The table names are a fixed literal map — nothing
 *  user-controlled is ever interpolated into SQL. */
const PLATFORM_TABLES: ReadonlyArray<{ platform: PublishPlatform; table: string }> = [
  { platform: "youtube", table: "youtube_posts" },
  { platform: "facebook", table: "facebook_posts" },
  { platform: "instagram", table: "instagram_posts" },
  { platform: "tiktok", table: "tiktok_posts" },
];

export async function getPublishingStats(
  range: AnalyticsRange,
  now: Date = new Date(),
): Promise<PlatformPublishStats[]> {
  const startedAt = Date.now();
  const cutoff = rangeCutoffIso(range, now);

  const stats = await Promise.all(
    PLATFORM_TABLES.map(async ({ platform, table }) => {
      const win = windowConds("created_at", cutoff, null);
      const rows = await all(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN posted_at IS NOT NULL THEN 1 ELSE 0 END) AS posted,
                SUM(CASE WHEN posted_at IS NULL AND status = 'failed' THEN 1 ELSE 0 END) AS failed,
                MAX(posted_at) AS last_posted_at
         FROM ${table}${where(["deleted_at IS NULL", ...win.conds])}`,
        win.params,
      );
      const total = num(rows[0]?.total);
      const posted = num(rows[0]?.posted);
      const failed = num(rows[0]?.failed);
      return {
        platform,
        total,
        posted,
        failed,
        pending: Math.max(0, total - posted - failed),
        lastPostedAt: str(rows[0]?.last_posted_at),
      };
    }),
  );

  logQuery("getPublishingStats", range, startedAt, stats.length);
  return stats;
}

// ---------------------------------------------------------------------------
// Per-story drilldown

export interface StoryAnalytics {
  story: {
    id: string;
    title: string;
    category: string | null;
    status: string | null;
    publishedAt: string | null;
    createdAt: string | null;
    duration: string | null;
    thumbnail: string | null;
  };
  /** Event counts inside the selected window. */
  totals: Record<StoryEventType, number>;
  /** Event counts since the beginning of time. */
  allTime: Record<StoryEventType, number>;
  /** Distinct anon viewers inside the window. */
  viewers: number;
  daily: DailySeries;
  poll: {
    question: string;
    optionA: string;
    optionB: string;
    enabled: boolean;
    votesA: number;
    votesB: number;
    totalVotes: number;
    divisiveness: number | null;
    votesInRange: number;
  } | null;
  memberSaves: number;
  memberLikes: number;
  comments: { total: number; published: number };
  posts: Array<{
    platform: PublishPlatform;
    status: string | null;
    trigger: string | null;
    postedAt: string | null;
    createdAt: string | null;
    externalId: string | null;
    attempts: number;
  }>;
}

function eventTotals(
  rows: Array<Record<string, unknown>>,
): Record<StoryEventType, number> {
  const totals = Object.fromEntries(
    STORY_EVENT_TYPES.map((t) => [t, 0]),
  ) as Record<StoryEventType, number>;
  for (const row of rows) {
    const type = String(row.t) as StoryEventType;
    if (type in totals) totals[type] = num(row.n);
  }
  return totals;
}

export async function getStoryAnalytics(
  storyId: string,
  range: AnalyticsRange,
  now: Date = new Date(),
): Promise<StoryAnalytics | null> {
  const startedAt = Date.now();
  const storyRows = await all(
    `SELECT id, title, category, status, published_at, created_at, duration,
            thumbnail_image
     FROM stories WHERE id = ?`,
    [storyId],
  );
  if (storyRows.length === 0) {
    logQuery("getStoryAnalytics(miss)", range, startedAt, 0);
    return null;
  }
  const s = storyRows[0];

  const win = windowConds("occurred_at", rangeCutoffIso(range, now), null);
  const inWindow = ["story_id = ?", ...win.conds];
  const inWindowParams = [storyId, ...win.params];

  const externalIdSql = (col: string, table: string) =>
    `SELECT status, "trigger", posted_at, created_at, ${col} AS external_id,
            COALESCE(attempts, 0) AS attempts
     FROM ${table} WHERE story_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC`;

  const [
    inRange,
    allTime,
    viewers,
    daily,
    pollRows,
    aggRows,
    saves,
    likes,
    comments,
    yt,
    fb,
    ig,
    tt,
  ] = await Promise.all([
    all(
      `SELECT event_type AS t, COUNT(*) AS n FROM story_events${where(inWindow)} GROUP BY event_type`,
      inWindowParams,
    ),
    all(
      `SELECT event_type AS t, COUNT(*) AS n FROM story_events WHERE story_id = ? GROUP BY event_type`,
      [storyId],
    ),
    all(
      `SELECT COUNT(DISTINCT anon_id) AS n FROM story_events${where([
        "anon_id IS NOT NULL",
        ...inWindow,
      ])}`,
      inWindowParams,
    ),
    dailySeriesForConds(
      range,
      now,
      ["story_id = ?"],
      [storyId],
      "getStoryAnalytics.daily",
    ),
    all(
      `SELECT id, question, option_a_text, option_b_text, enabled
       FROM polls WHERE story_id = ?`,
      [storyId],
    ),
    all(
      `SELECT votes_a, votes_b, total_votes, divisiveness
       FROM poll_aggregates WHERE story_id = ?`,
      [storyId],
    ),
    all(`SELECT COUNT(*) AS n FROM user_saves WHERE story_id = ?`, [storyId]),
    all(`SELECT COUNT(*) AS n FROM user_likes WHERE story_id = ?`, [storyId]),
    all(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN c.status = 'published' THEN 1 ELSE 0 END) AS published
       FROM comments c JOIN articles a ON a.id = c.article_id
       WHERE a.story_id = ?`,
      [storyId],
    ),
    all(externalIdSql("external_video_id", "youtube_posts"), [storyId]),
    all(externalIdSql("external_post_id", "facebook_posts"), [storyId]),
    all(externalIdSql("external_post_id", "instagram_posts"), [storyId]),
    all(externalIdSql("external_post_id", "tiktok_posts"), [storyId]),
  ]);

  let poll: StoryAnalytics["poll"] = null;
  if (pollRows.length > 0) {
    const p = pollRows[0];
    const agg = aggRows[0];
    const voteWin = windowConds("created_at", rangeCutoffIso(range, now), null);
    const votesInRange = await all(
      `SELECT COUNT(*) AS n FROM poll_votes${where([
        "poll_id = ?",
        ...voteWin.conds,
      ])}`,
      [String(p.id), ...voteWin.params],
    );
    poll = {
      question: str(p.question) ?? "",
      optionA: str(p.option_a_text) ?? "A",
      optionB: str(p.option_b_text) ?? "B",
      enabled: num(p.enabled) === 1,
      votesA: num(agg?.votes_a),
      votesB: num(agg?.votes_b),
      totalVotes: num(agg?.total_votes),
      divisiveness: agg ? num(agg.divisiveness) : null,
      votesInRange: num(votesInRange[0]?.n),
    };
  }

  const toPost = (
    platform: PublishPlatform,
    rows: Array<Record<string, unknown>>,
  ): StoryAnalytics["posts"] =>
    rows.map((r) => ({
      platform,
      status: str(r.status),
      trigger: str(r.trigger),
      postedAt: str(r.posted_at),
      createdAt: str(r.created_at),
      externalId: str(r.external_id),
      attempts: num(r.attempts),
    }));

  const result: StoryAnalytics = {
    story: {
      id: String(s.id),
      title: str(s.title) ?? String(s.id),
      category: str(s.category),
      status: str(s.status),
      publishedAt: str(s.published_at),
      createdAt: str(s.created_at),
      duration: str(s.duration),
      thumbnail: resolveMediaUrl(str(s.thumbnail_image)),
    },
    totals: eventTotals(inRange),
    allTime: eventTotals(allTime),
    viewers: num(viewers[0]?.n),
    daily,
    poll,
    memberSaves: num(saves[0]?.n),
    memberLikes: num(likes[0]?.n),
    comments: {
      total: num(comments[0]?.total),
      published: num(comments[0]?.published),
    },
    posts: [
      ...toPost("youtube", yt),
      ...toPost("facebook", fb),
      ...toPost("instagram", ig),
      ...toPost("tiktok", tt),
    ].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
  };

  logQuery("getStoryAnalytics", range, startedAt, inRange.length);
  return result;
}
