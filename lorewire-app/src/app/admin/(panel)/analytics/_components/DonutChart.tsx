import { formatCompact, fractions } from "@/lib/chart-math";

export interface DonutSlice {
  label: string;
  value: number;
  /** CSS color (hex or var(--color-...)). */
  color: string;
}

const SIZE = 120;
const STROKE = 16;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;

// Share-of-total donut (event mix). Server-rendered SVG: each slice is a
// circle stroke offset around the ring via dasharray, legend alongside.
export default function DonutChart({ slices }: { slices: DonutSlice[] }) {
  const fracs = fractions(slices.map((s) => s.value));
  const total = slices.reduce((a, s) => a + Math.max(0, s.value), 0);

  if (fracs.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line p-4 text-center text-[13px] text-muted">
        No activity in this window.
      </p>
    );
  }

  // Each slice starts where the previous ones end: offset i is the sum of
  // the fractions before it. Computed without reassignment so the render
  // stays pure (react-hooks/immutability).
  const arcs = slices.map((s, i) => ({
    ...s,
    frac: fracs[i],
    dashOffset: -fracs.slice(0, i).reduce((a, b) => a + b, 0) * C,
  }));

  return (
    <div className="flex items-center gap-5">
      <div className="relative shrink-0">
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          aria-label="Share of events by type"
        >
          <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
            {arcs.map(
              (a) =>
                a.frac > 0 && (
                  <circle
                    key={a.label}
                    cx={SIZE / 2}
                    cy={SIZE / 2}
                    r={R}
                    fill="none"
                    stroke={a.color}
                    strokeWidth={STROKE}
                    strokeDasharray={`${a.frac * C} ${C}`}
                    strokeDashoffset={a.dashOffset}
                  />
                ),
            )}
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display text-[18px] font-extrabold tracking-tightest text-ink">
            {formatCompact(total)}
          </span>
          <span className="font-mono text-[9px] uppercase tracking-wider text-muted">
            events
          </span>
        </div>
      </div>
      <ul className="min-w-0 flex-1 space-y-1.5">
        {arcs.map((a) => (
          <li key={a.label} className="flex items-center gap-2 text-[12px]">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: a.color }}
            />
            <span className="truncate text-ink">{a.label}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">
              {formatCompact(a.value)} · {Math.round(a.frac * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
