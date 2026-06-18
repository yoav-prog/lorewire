// /admin/polls — one-row-per-poll overview. Pulls every poll + its
// aggregate + the parent story title in a single trip via
// listPollOverview. Empty state nudges the admin toward the story
// editor where the poll is actually authored.
//
// Plan: _plans/2026-06-17-engagement-polls.md (Phase 1, F10).
// Sparkline + per-story vote series land in Phase 5.

import Link from "next/link";
import { requireAdmin } from "@/lib/dal";
import Breadcrumb from "@/app/admin/Breadcrumb";
import {
  DEFAULT_PUBLIC_FLOOR,
  listPollOverview,
  toResultView,
} from "@/lib/polls";
import { BackfillButton } from "./BackfillButton";

export const dynamic = "force-dynamic";

const LABEL =
  "font-mono text-[11px] uppercase tracking-wider text-muted";

export default async function PollsOverviewPage() {
  await requireAdmin();
  const rows = await listPollOverview();

  return (
    <div className="space-y-5">
      <Breadcrumb trail={[{ href: "/admin", label: "Overview" }]} />

      <header className="space-y-1">
        <h1 className="font-display text-[24px] font-extrabold tracking-tightest text-ink">
          Engagement polls
        </h1>
        <p className="text-[13px] text-muted">
          One poll per story or article. Author them from the
          corresponding edit page; this table is the cross-cutting view
          of every active question and how the audience is voting.
        </p>
      </header>

      <BackfillButton />

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line bg-surface p-8 text-center">
          <p className="text-[14px] text-ink">No polls yet.</p>
          <p className="mt-1 text-[13px] text-muted">
            Open a story in{" "}
            <Link
              href="/admin/content"
              className="text-ink underline decoration-line hover:decoration-accent"
            >
              Content
            </Link>{" "}
            and author a poll from its sidebar.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full border-collapse text-[13px]">
            <thead className="border-b border-line">
              <tr className="text-left">
                <th className={`${LABEL} px-4 py-3`}>Story</th>
                <th className={`${LABEL} px-4 py-3`}>Question</th>
                <th className={`${LABEL} px-4 py-3`}>Votes</th>
                <th className={`${LABEL} px-4 py-3`}>Split</th>
                <th className={`${LABEL} px-4 py-3`}>Divisiveness</th>
                <th className={`${LABEL} px-4 py-3`}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const view = toResultView(row.aggregate, DEFAULT_PUBLIC_FLOOR);
                const isEnabled = row.poll.enabled === 1;
                return (
                  <tr
                    key={row.poll.id}
                    className="border-t border-line align-top"
                  >
                    <td className="px-4 py-3">
                      {row.poll.story_id ? (
                        <Link
                          href={`/admin/stories/${row.poll.story_id}`}
                          className="text-ink underline decoration-line hover:decoration-accent"
                        >
                          {row.storyTitle ??
                            `(${row.poll.story_id.slice(0, 8)})`}
                        </Link>
                      ) : row.poll.article_id ? (
                        <Link
                          href={`/admin/articles/${row.poll.article_id}`}
                          className="text-ink underline decoration-line hover:decoration-accent"
                        >
                          Article poll{" "}
                          <span className="font-mono text-muted">
                            ({row.poll.article_id.slice(0, 8)})
                          </span>
                        </Link>
                      ) : (
                        <span className="font-mono text-[12px] text-muted">
                          orphan poll ({row.poll.id.slice(0, 8)})
                        </span>
                      )}
                      {row.storyCategory && (
                        <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
                          {row.storyCategory}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-ink">{row.poll.question}</div>
                      <div className="mt-0.5 font-mono text-[10px] text-muted">
                        {row.poll.option_a_text} / {row.poll.option_b_text}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-ink">
                      {view.totalVotes}
                    </td>
                    <td className="px-4 py-3">
                      {view.hasFloor ? (
                        <span className="font-mono text-ink">
                          {view.pctA}% / {view.pctB}%
                        </span>
                      ) : (
                        <span className="font-mono text-muted">
                          &lt; {DEFAULT_PUBLIC_FLOOR} votes
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-ink">
                      {row.aggregate
                        ? row.aggregate.divisiveness.toFixed(2)
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                          isEnabled
                            ? "border-cat-wholesome/40 bg-cat-wholesome/15 text-cat-wholesome"
                            : "border-line bg-surface2 text-muted"
                        }`}
                      >
                        {isEnabled ? "Live" : "Paused"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className={LABEL}>
        Floor: percentages hide below {DEFAULT_PUBLIC_FLOOR} votes (see plan
        §6 N6). Aggregates refresh every 5 minutes once the cron lands.
      </p>
    </div>
  );
}
