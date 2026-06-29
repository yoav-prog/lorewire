import Link from "next/link";
import { requireStaff } from "@/lib/dal";
import { dashboardSummary, listStoriesSlim } from "@/lib/repo";
import { allSelected, STAGES, STAGE_LABEL } from "@/lib/models";
import { statusClass } from "@/app/admin/ui";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="mt-1 font-display text-[28px] font-extrabold tracking-tightest text-ink">
        {value}
      </div>
    </div>
  );
}

export default async function Dashboard() {
  await requireStaff();
  const [summary, recent, models] = await Promise.all([
    dashboardSummary(),
    listStoriesSlim({ limit: 8 }),
    allSelected(),
  ]);

  const counts = summary.byStatus;
  const spentUsd = (summary.totalCostCents / 100).toFixed(2);

  return (
    <div className="space-y-7">
      <div>
        <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
          Overview
        </h1>
        <p className="mt-1 text-[14px] text-muted">
          The content pipeline writes here; review, then publish.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total" value={summary.total} />
        <Stat label="In review" value={(counts.review ?? 0) + (counts.scripted ?? 0)} />
        <Stat label="Published" value={counts.published ?? 0} />
        <Stat label="Spend (USD)" value={`$${spentUsd}`} />
      </div>

      <section className="grid gap-3 sm:grid-cols-3">
        {STAGES.map((st) => (
          <div key={st} className="rounded-xl border border-line bg-surface p-4">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
              {STAGE_LABEL[st]}
            </div>
            <div className="mt-1 truncate text-[14px] text-ink">{models[st]}</div>
          </div>
        ))}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-mono text-[12px] uppercase tracking-wider text-muted">
            Recent
          </h2>
          <Link href="/admin/videos" className="text-[13px] text-accent hover:underline">
            All videos
          </Link>
        </div>
        <div className="overflow-hidden rounded-xl border border-line">
          {recent.length === 0 ? (
            <p className="bg-surface p-6 text-center text-[14px] text-muted">
              No stories yet. Run the pipeline to generate one.
            </p>
          ) : (
            recent.map((s) => (
              <Link
                key={s.id}
                href={`/admin/stories/${s.id}`}
                className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 last:border-0 hover:bg-surface2"
              >
                <span className="truncate text-[14px] text-ink">
                  {s.title || s.id}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="font-mono text-[11px] text-muted">
                    {s.category}
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${statusClass(
                      s.status,
                    )}`}
                  >
                    {s.status ?? "draft"}
                  </span>
                </span>
              </Link>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
