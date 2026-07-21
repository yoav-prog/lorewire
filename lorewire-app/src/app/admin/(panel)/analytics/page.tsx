import Link from "next/link";
import { requireCapability } from "@/lib/dal";
import {
  getAnalyticsOverview,
  getCategoryBreakdown,
  getDailySeries,
  getPollInsights,
  getPublishingStats,
  getStoryPerformance,
  parseAnalyticsRange,
  ANALYTICS_RANGES,
  POLL_SPOTLIGHT_MIN_VOTES,
  type PollSpotlight,
} from "@/lib/analytics";
import { CAT_COLORS, isCategoryLabel } from "@/lib/categories/manifest";
import { formatCompact, formatPercent, percentChange } from "@/lib/chart-math";
import BarList from "./_components/BarList";
import DonutChart from "./_components/DonutChart";
import KpiCard from "./_components/KpiCard";
import RangePicker from "./_components/RangePicker";
import StoryPerformanceTable from "./_components/StoryPerformanceTable";
import TrendChart from "./_components/TrendChart";

// Site analytics, computed entirely from first-party data the app already
// records (story_events, poll_votes, comments, users, publish logs).
// Read-only; the range lives in ?range= so every view is a shareable URL.
// Plan: _plans/2026-07-05-admin-analytics.md.

export const dynamic = "force-dynamic";

// Series / slice colors, all from the design-token palette so light and
// dark themes both work without chart-specific styling.
const COLOR = {
  plays: "var(--color-accent)",
  completions: "var(--color-cat-wholesome)",
  votes: "var(--color-cat-dating)",
  saves: "var(--color-cat-humor)",
  shares: "var(--color-cat-roommate)",
  ratings: "var(--color-cat-entitled)",
} as const;

function categoryColor(label: string): string {
  return isCategoryLabel(label) ? CAT_COLORS[label] : "var(--color-accent)";
}

const PLATFORM_LABEL: Record<string, string> = {
  youtube: "YouTube",
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
};

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireCapability("content.manage");
  const { range: rangeParam } = await searchParams;
  const range = parseAnalyticsRange(rangeParam);
  const rangeDef = ANALYTICS_RANGES.find((r) => r.range === range)!;

  const [overview, daily, categories, stories, polls, publishing] =
    await Promise.all([
      getAnalyticsOverview(range),
      getDailySeries(range),
      getCategoryBreakdown(range),
      getStoryPerformance(range),
      getPollInsights(range),
      getPublishingStats(range),
    ]);

  const kpi = overview.current;
  const prev = overview.previous;
  const delta = (pick: (k: typeof kpi) => number) =>
    prev ? percentChange(pick(kpi), pick(prev)) : null;

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
            Analytics
          </h1>
          <p className="mt-1 text-[14px] text-muted">
            How the site is doing: plays, polls, saves and shares across{" "}
            {rangeDef.label.toLowerCase()}. Counts cover visitors who accepted
            analytics consent, so real traffic runs higher.
          </p>
        </div>
        <RangePicker basePath="/admin/analytics" active={rangeDef.param} />
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard
          label="Plays"
          value={kpi.plays}
          delta={delta((k) => k.plays)}
        />
        <KpiCard
          label="Completion rate"
          value={0}
          formatted={formatPercent(
            kpi.plays > 0 ? kpi.completions / kpi.plays : null,
          )}
          hint={`${formatCompact(kpi.completions)} of ${formatCompact(kpi.plays)} plays finished`}
        />
        <KpiCard
          label="Unique viewers"
          value={kpi.uniqueViewers}
          delta={delta((k) => k.uniqueViewers)}
        />
        <KpiCard
          label="Poll votes"
          value={kpi.pollVotes}
          delta={delta((k) => k.pollVotes)}
        />
        <KpiCard
          label="Saves"
          value={kpi.saves}
          delta={delta((k) => k.saves)}
        />
        <KpiCard
          label="Shares"
          value={kpi.shares}
          delta={delta((k) => k.shares)}
        />
        <KpiCard
          label="Comments"
          value={kpi.comments}
          delta={delta((k) => k.comments)}
        />
        <KpiCard
          label="New members"
          value={kpi.newMembers}
          delta={delta((k) => k.newMembers)}
        />
      </div>

      {/* Engagement trend */}
      <section className="rounded-xl border border-line bg-surface p-4">
        <SectionHeading
          title="Engagement over time"
          hint="Daily events across the whole site"
        />
        <TrendChart
          labels={daily.days}
          series={[
            {
              key: "plays",
              label: "Plays",
              color: COLOR.plays,
              values: daily.counts.play_started,
            },
            {
              key: "completions",
              label: "Completions",
              color: COLOR.completions,
              values: daily.counts.play_completed,
            },
            {
              key: "votes",
              label: "Poll votes",
              color: COLOR.votes,
              values: daily.counts.poll_vote,
            },
            {
              key: "saves",
              label: "Saves",
              color: COLOR.saves,
              values: daily.counts.save_added,
            },
          ]}
        />
      </section>

      {/* Category + event mix */}
      <section className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface p-4">
          <SectionHeading
            title="Categories"
            hint="Events by story category"
          />
          <BarList
            rows={categories.map((c) => ({
              label: c.category,
              value: c.events,
              color: categoryColor(c.category),
              detail:
                c.plays > 0
                  ? `${formatPercent(c.completions / c.plays)} completed`
                  : undefined,
            }))}
          />
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <SectionHeading title="Event mix" hint="What viewers actually do" />
          <DonutChart
            slices={[
              { label: "Plays", value: kpi.plays, color: COLOR.plays },
              {
                label: "Completions",
                value: kpi.completions,
                color: COLOR.completions,
              },
              { label: "Poll votes", value: kpi.pollVotes, color: COLOR.votes },
              { label: "Saves", value: kpi.saves, color: COLOR.saves },
              { label: "Ratings", value: kpi.ratings, color: COLOR.ratings },
              { label: "Shares", value: kpi.shares, color: COLOR.shares },
            ]}
          />
        </div>
      </section>

      {/* Audience */}
      <section className="rounded-xl border border-line bg-surface p-4">
        <SectionHeading
          title="Audience"
          hint="Distinct consented viewers per day"
        />
        <TrendChart
          labels={daily.days}
          series={[
            {
              key: "viewers",
              label: "Unique viewers",
              color: COLOR.plays,
              values: daily.viewers,
            },
          ]}
        />
      </section>

      {/* Story performance */}
      <section>
        <SectionHeading
          title="Story performance"
          hint="Every public story, ranked by engagement score. Click a story for its full breakdown."
        />
        <StoryPerformanceTable rows={stories} rangeLabel={rangeDef.label} />
      </section>

      {/* Polls */}
      <section className="space-y-3">
        <SectionHeading
          title="Polls"
          hint={`${formatCompact(polls.votesInRange)} votes across ${formatCompact(polls.pollsVotedInRange)} polls in ${rangeDef.label.toLowerCase()}`}
        />
        <div className="grid gap-3 lg:grid-cols-3">
          <PollLeaderCard polls={polls.topVoted} />
          <PollSpotlightCard
            title="Most divisive"
            hint="Closest to a 50/50 split"
            items={polls.mostDivisive}
          />
          <PollSpotlightCard
            title="Most agreed"
            hint="Closest to unanimous"
            items={polls.mostAgreed}
          />
        </div>
      </section>

      {/* Publishing */}
      <section>
        <SectionHeading
          title="Social publishing"
          hint={`Posts created in ${rangeDef.label.toLowerCase()}`}
        />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {publishing.map((p) => (
            <div
              key={p.platform}
              className="rounded-xl border border-line bg-surface p-4"
            >
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
                {PLATFORM_LABEL[p.platform] ?? p.platform}
              </div>
              <div className="mt-1 font-display text-[24px] font-extrabold tracking-tightest text-ink">
                {formatCompact(p.posted)}
                <span className="ml-1 text-[13px] font-normal text-muted">
                  posted
                </span>
              </div>
              <div className="mt-1 flex items-center gap-3 text-[11px]">
                {p.failed > 0 ? (
                  <span className="text-danger">{p.failed} failed</span>
                ) : (
                  <span className="text-muted">no failures</span>
                )}
                {p.pending > 0 && (
                  <span className="text-muted">{p.pending} pending</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3">
      <h2 className="font-mono text-[12px] uppercase tracking-wider text-muted">
        {title}
      </h2>
      {hint && <p className="mt-0.5 text-[12px] text-muted">{hint}</p>}
    </div>
  );
}

function PollLeaderCard({
  polls,
}: {
  polls: Awaited<ReturnType<typeof getPollInsights>>["topVoted"];
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-muted">
        Most voted
      </h3>
      {polls.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted">No votes in this window.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {polls.slice(0, 5).map((p) => {
            const pctA =
              p.votes > 0 ? Math.round((p.votesA / p.votes) * 100) : 0;
            return (
              <li key={p.pollId} className="text-[13px]">
                <PollSubjectLink
                  storyId={p.storyId}
                  articleId={p.articleId}
                  label={p.subjectTitle ?? p.question}
                />
                <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-surface2">
                  <span
                    className="h-full bg-accent"
                    style={{ width: `${pctA}%` }}
                  />
                  <span
                    className="h-full bg-cat-roommate"
                    style={{ width: `${100 - pctA}%` }}
                  />
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-muted">
                  {formatCompact(p.votes)} votes · {pctA}% {p.optionA}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PollSpotlightCard({
  title,
  hint,
  items,
}: {
  title: string;
  hint: string;
  items: PollSpotlight[];
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-muted">
        {title}
      </h3>
      <p className="mt-0.5 text-[11px] text-muted">
        {hint} · min {POLL_SPOTLIGHT_MIN_VOTES} votes, all time
      </p>
      {items.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted">
          Not enough votes yet.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((s) => {
            const pctA =
              s.totalVotes > 0
                ? Math.round((s.votesA / s.totalVotes) * 100)
                : 0;
            return (
              <li key={s.storyId} className="text-[13px]">
                <Link
                  href={`/admin/analytics/${s.storyId}`}
                  className="block truncate text-ink hover:text-accent"
                  title={s.title ?? s.storyId}
                >
                  {s.title ?? s.storyId}
                </Link>
                <div className="font-mono text-[10px] text-muted">
                  {pctA}/{100 - pctA} split · {formatCompact(s.totalVotes)} votes
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PollSubjectLink({
  storyId,
  articleId,
  label,
}: {
  storyId: string | null;
  articleId: string | null;
  label: string;
}) {
  const href = storyId
    ? `/admin/analytics/${storyId}`
    : articleId
      ? `/admin/articles/${articleId}`
      : null;
  if (!href) {
    return <span className="block truncate text-ink">{label}</span>;
  }
  return (
    <Link
      href={href}
      className="block truncate text-ink hover:text-accent"
      title={label}
    >
      {label}
    </Link>
  );
}
