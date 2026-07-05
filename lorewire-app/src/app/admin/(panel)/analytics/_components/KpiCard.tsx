import { formatCompact } from "@/lib/chart-math";

// One headline number in the dashboard's KPI grid, with an optional delta
// vs the previous window. Delta null = no baseline ("all time" range or a
// zero previous window) — shown as a quiet "no baseline" rather than a
// fake percentage.
export default function KpiCard({
  label,
  value,
  delta,
  hint,
  formatted,
}: {
  label: string;
  value: number;
  /** Percent change vs the previous window (12 = +12%); null = no baseline. */
  delta?: number | null;
  /** Small muted line under the value (e.g. "of 812 plays"). */
  hint?: string;
  /** Pre-formatted value display; defaults to compact notation. */
  formatted?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-display text-[28px] font-extrabold tracking-tightest text-ink">
          {formatted ?? formatCompact(value)}
        </span>
        {delta !== undefined && <Delta value={delta} />}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

function Delta({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
        no baseline
      </span>
    );
  }
  const rounded = Math.round(value);
  if (rounded === 0) {
    return <span className="font-mono text-[11px] text-muted">±0%</span>;
  }
  const up = rounded > 0;
  return (
    <span
      className={`font-mono text-[11px] ${up ? "text-cat-wholesome" : "text-danger"}`}
      title="vs the previous period"
    >
      {up ? "▲" : "▼"} {Math.abs(rounded)}%
    </span>
  );
}
