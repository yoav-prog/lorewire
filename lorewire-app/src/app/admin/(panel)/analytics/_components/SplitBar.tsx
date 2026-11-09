import { formatCompact } from "@/lib/chart-math";

// A/B poll split: one bar, two segments, labels underneath. Server-only.
// Zero votes renders a neutral bar so the layout never collapses.
export default function SplitBar({
  aLabel,
  bLabel,
  aVotes,
  bVotes,
}: {
  aLabel: string;
  bLabel: string;
  aVotes: number;
  bVotes: number;
}) {
  const total = aVotes + bVotes;
  const aPct = total > 0 ? Math.round((aVotes / total) * 100) : 50;
  const bPct = total > 0 ? 100 - aPct : 50;

  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-surface2">
        {total > 0 && (
          <>
            <span
              className="h-full bg-accent"
              style={{ width: `${aPct}%` }}
            />
            <span
              className="h-full bg-cat-roommate"
              style={{ width: `${bPct}%` }}
            />
          </>
        )}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-3 text-[12px]">
        <span className="min-w-0 truncate text-ink" title={aLabel}>
          <span className="font-mono text-[11px] text-accent">{aPct}%</span>{" "}
          {aLabel}
        </span>
        <span className="min-w-0 truncate text-right text-ink" title={bLabel}>
          {bLabel}{" "}
          <span className="font-mono text-[11px] text-cat-roommate">
            {bPct}%
          </span>
        </span>
      </div>
      <div className="mt-0.5 text-[11px] text-muted">
        {total > 0
          ? `${formatCompact(total)} votes (${formatCompact(aVotes)} vs ${formatCompact(bVotes)})`
          : "No votes yet."}
      </div>
    </div>
  );
}
