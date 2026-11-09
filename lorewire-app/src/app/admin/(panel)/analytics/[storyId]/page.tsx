import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/dal";
import {
  getStoryAnalytics,
  parseAnalyticsRange,
  ANALYTICS_RANGES,
} from "@/lib/analytics";
import { formatCompact, formatPercent } from "@/lib/chart-math";
import { statusClass } from "@/app/admin/ui";
import BarList from "../_components/BarList";
import KpiCard from "../_components/KpiCard";
import RangePicker from "../_components/RangePicker";
import SplitBar from "../_components/SplitBar";
import TrendChart from "../_components/TrendChart";

// Per-story analytics drilldown: everything the site knows about how one
// story performs — event trend, play funnel, poll split, member saves and
// likes, comments, and its social publish history. Linked from every row
// of the overview table. Plan: _plans/2026-07-05-admin-analytics.md.

export const dynamic = "force-dynamic";

const PLATFORM_LABEL: Record<string, string> = {
  youtube: "YouTube",
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
};

function postStatusClass(status: string | null, postedAt: string | null): string {
  if (postedAt) return "border-cat-wholesome/40 bg-cat-wholesome/20 text-cat-wholesome";
  if (status === "failed") return "border-danger/40 bg-danger/15 text-danger";
  return "border-line bg-surface2 text-muted";
}

function shortDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "n/a";
}

export default async function StoryAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ storyId: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  await requireCapability("content.manage");
  const [{ storyId }, { range: rangeParam }] = await Promise.all([
    params,
    searchParams,
  ]);
  const range = parseAnalyticsRange(rangeParam);
  const rangeDef = ANALYTICS_RANGES.find((r) => r.range === range)!;

  const data = await getStoryAnalytics(storyId, range);
  if (!data) notFound();

  const { story, totals, allTime, poll } = data;
  const completionRate =
    totals.play_started > 0 ? totals.play_completed / totals.play_started : null;

  return (
    <div className="space-y-7">
      <div>
        <Link
          href="/admin/analytics"
          className="font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-accent"
        >
          &larr; Analytics
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-4">
            {story.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element -- admin thumb, remote R2 host
              <img
                src={story.thumbnail}
                alt=""
                className="h-24 w-16 shrink-0 rounded-lg border border-line object-cover"
              />
            ) : (
              <span className="h-24 w-16 shrink-0 rounded-lg border border-line bg-surface2" />
            )}
            <div className="min-w-0">
              <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
                {story.title}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                <span
                  className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${statusClass(story.status)}`}
                >
                  {story.status ?? "draft"}
                </span>
                {story.category && (
                  <span className="font-mono text-[11px]">{story.category}</span>
                )}
                {story.duration && <span>{story.duration}</span>}
                <span>
                  {story.publishedAt
                    ? `published ${shortDate(story.publishedAt)}`
                    : "not published"}
                </span>
                <Link
                  href={`/admin/stories/${story.id}`}
                  className="text-accent hover:underline"
                >
                  Edit story
                </Link>
              </div>
            </div>
          </div>
          <RangePicker
            basePath={`/admin/analytics/${story.id}`}
            active={rangeDef.param}
          />
        </div>
      </div>

      {/* KPI grid (selected window) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard
          label="Plays"
          value={totals.play_started}
          hint={`${formatCompact(allTime.play_started)} all time`}
        />
        <KpiCard
          label="Completion rate"
          value={0}
          formatted={formatPercent(completionRate)}
          hint={`${formatCompact(totals.play_completed)} completions`}
        />
        <KpiCard
          label="Unique viewers"
          value={data.viewers}
          hint={rangeDef.label.toLowerCase()}
        />
        <KpiCard
          label="Poll votes"
          value={totals.poll_vote}
          hint={`${formatCompact(allTime.poll_vote)} all time`}
        />
        <KpiCard
          label="Saves"
          value={totals.save_added}
          hint={`${formatCompact(data.memberSaves)} on member lists`}
        />
        <KpiCard
          label="Likes"
          value={data.memberLikes}
          hint="signed-in members, all time"
        />
        <KpiCard
          label="Shares"
          value={totals.share_initiated}
          hint={`${formatCompact(allTime.share_initiated)} all time`}
        />
        <KpiCard
          label="Comments"
          value={data.comments.total}
          hint={`${formatCompact(data.comments.published)} published`}
        />
      </div>

      {/* Trend */}
      <section className="rounded-xl border border-line bg-surface p-4">
        <SectionHeading
          title="Engagement over time"
          hint="Daily events for this story"
        />
        <TrendChart
          labels={data.daily.days}
          series={[
            {
              key: "plays",
              label: "Plays",
              color: "var(--color-accent)",
              values: data.daily.counts.play_started,
            },
            {
              key: "completions",
              label: "Completions",
              color: "var(--color-cat-wholesome)",
              values: data.daily.counts.play_completed,
            },
            {
              key: "votes",
              label: "Poll votes",
              color: "var(--color-cat-dating)",
              values: data.daily.counts.poll_vote,
            },
          ]}
        />
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        {/* Funnel */}
        <div className="rounded-xl border border-line bg-surface p-4">
          <SectionHeading
            title="Play funnel"
            hint={`Started vs finished (90% watched), ${rangeDef.label.toLowerCase()}`}
          />
          <BarList
            rows={[
              {
                label: "Started",
                value: totals.play_started,
                color: "var(--color-accent)",
              },
              {
                label: "Completed",
                value: totals.play_completed,
                color: "var(--color-cat-wholesome)",
                detail: formatPercent(completionRate),
              },
            ]}
          />
        </div>

        {/* Poll */}
        <div className="rounded-xl border border-line bg-surface p-4">
          <SectionHeading
            title="Poll"
            hint={
              poll
                ? poll.enabled
                  ? "Live on the story"
                  : "Disabled"
                : undefined
            }
          />
          {poll ? (
            <div className="space-y-3">
              <p className="text-[14px] text-ink">{poll.question}</p>
              <SplitBar
                aLabel={poll.optionA}
                bLabel={poll.optionB}
                aVotes={poll.votesA}
                bVotes={poll.votesB}
              />
              <p className="text-[11px] text-muted">
                {formatCompact(poll.votesInRange)} votes in{" "}
                {rangeDef.label.toLowerCase()}
                {poll.divisiveness !== null &&
                  ` · divisiveness ${poll.divisiveness.toFixed(2)}`}
              </p>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-line p-4 text-center text-[13px] text-muted">
              This story has no poll.
            </p>
          )}
        </div>
      </section>

      {/* Social posts */}
      <section>
        <SectionHeading
          title="Social publishing"
          hint="Every publish attempt for this story, newest first"
        />
        {data.posts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line bg-surface p-8 text-center">
            <p className="text-[14px] text-ink">Not published to social yet.</p>
            <p className="mt-1 text-[13px] text-muted">
              Publishes land here once the scheduler or a manual publish runs.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full border-collapse text-[13px]">
              <thead className="border-b border-line">
                <tr className="text-left">
                  <Th>Platform</Th>
                  <Th>Status</Th>
                  <Th>Trigger</Th>
                  <Th>Posted</Th>
                  <Th>Attempts</Th>
                  <Th>External id</Th>
                </tr>
              </thead>
              <tbody>
                {data.posts.map((p, i) => (
                  <tr key={`${p.platform}-${i}`} className="border-t border-line">
                    <td className="px-4 py-3 text-ink">
                      {PLATFORM_LABEL[p.platform] ?? p.platform}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${postStatusClass(p.status, p.postedAt)}`}
                      >
                        {p.postedAt ? "posted" : (p.status ?? "pending")}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-muted">
                      {p.trigger ?? "n/a"}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-muted">
                      {shortDate(p.postedAt)}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-muted">
                      {p.attempts}
                    </td>
                    <td className="max-w-[160px] truncate px-4 py-3 font-mono text-[11px] text-muted">
                      {p.externalId ?? "n/a"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-muted">
      {children}
    </th>
  );
}
