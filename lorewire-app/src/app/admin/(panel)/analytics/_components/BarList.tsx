import { formatCompact } from "@/lib/chart-math";

export interface BarListRow {
  label: string;
  value: number;
  /** CSS color for the bar (hex or var(--color-...)). */
  color: string;
  /** Small muted text after the value (e.g. "62% completed"). */
  detail?: string;
}

// Horizontal bar breakdown (categories, funnels). Server-rendered — the
// bars are plain divs scaled against the max value, no client JS.
export default function BarList({ rows }: { rows: BarListRow[] }) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  if (rows.length === 0 || max <= 0) {
    return (
      <p className="rounded-lg border border-dashed border-line p-4 text-center text-[13px] text-muted">
        No activity in this window.
      </p>
    );
  }
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label} className="flex items-center gap-3">
          <span className="w-24 shrink-0 truncate text-[12px] text-ink" title={r.label}>
            {r.label}
          </span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface2">
            <span
              className="block h-full rounded-full"
              style={{
                width: `${Math.max(1, (r.value / max) * 100)}%`,
                backgroundColor: r.color,
              }}
            />
          </span>
          <span className="w-12 shrink-0 text-right font-mono text-[12px] text-ink">
            {formatCompact(r.value)}
          </span>
          {r.detail && (
            <span className="w-24 shrink-0 text-right text-[11px] text-muted">
              {r.detail}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
