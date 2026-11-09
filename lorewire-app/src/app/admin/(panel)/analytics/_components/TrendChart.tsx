"use client";

import { useMemo, useRef, useState } from "react";
import {
  areaPath,
  formatCompact,
  linePath,
  niceTicks,
  seriesPoints,
  shortDayLabel,
  type ChartPoint,
} from "@/lib/chart-math";

export interface TrendSeries {
  key: string;
  label: string;
  /** CSS color (hex or var(--color-...)). */
  color: string;
  values: number[];
}

// Multi-series daily trend chart. Hand-rolled SVG (the repo carries no
// chart dependency): shared y-scale with nice ticks, area fill under the
// first series, hover crosshair + tooltip, legend. All series must be the
// same length as `labels` (one value per day).
//
// Geometry lives in lib/chart-math.ts so it stays unit-tested; this file
// only maps pointer position -> nearest day and renders.

const W = 720;
const H = 220;
const PAD_L = 40;
const PAD_R = 10;
const PAD_T = 10;
const PAD_B = 22;
const INNER_W = W - PAD_L - PAD_R;
const INNER_H = H - PAD_T - PAD_B;

export default function TrendChart({
  labels,
  series,
}: {
  labels: string[];
  series: TrendSeries[];
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const { ticks, scaleMax, points, hasData } = useMemo(() => {
    const maxValue = Math.max(0, ...series.flatMap((s) => s.values));
    const ticks = niceTicks(maxValue);
    const scaleMax = ticks[ticks.length - 1] || 1;
    const points = new Map<string, ChartPoint[]>(
      series.map((s) => [s.key, seriesPoints(s.values, INNER_W, INNER_H, scaleMax)]),
    );
    return { ticks, scaleMax, points, hasData: maxValue > 0 };
  }, [series]);

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg || labels.length === 0) return;
    const rect = svg.getBoundingClientRect();
    // The svg scales with its container; map client x back to viewBox x.
    const viewX = ((e.clientX - rect.left) / rect.width) * W - PAD_L;
    const step = labels.length > 1 ? INNER_W / (labels.length - 1) : INNER_W;
    const idx = Math.round(viewX / step);
    setHover(Math.max(0, Math.min(labels.length - 1, idx)));
  }

  const hoverX =
    hover === null || labels.length === 0
      ? null
      : labels.length === 1
        ? INNER_W / 2
        : (hover * INNER_W) / (labels.length - 1);

  // ~5 evenly spaced x-axis labels, always including first and last.
  const xLabelIdx = useMemo(() => {
    const n = labels.length;
    if (n <= 6) return labels.map((_, i) => i);
    const step = (n - 1) / 4;
    return [0, 1, 2, 3, 4].map((i) => Math.round(i * step));
  }, [labels]);

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Daily engagement trend"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* Gridlines + y labels */}
        {ticks.map((t) => {
          const y = PAD_T + INNER_H - (t / scaleMax) * INNER_H;
          return (
            <g key={t}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y}
                y2={y}
                stroke="var(--color-line)"
                strokeWidth={1}
              />
              <text
                x={PAD_L - 6}
                y={y + 3}
                textAnchor="end"
                fontSize={9}
                fill="var(--color-muted)"
                fontFamily="var(--font-mono, monospace)"
              >
                {formatCompact(t)}
              </text>
            </g>
          );
        })}

        {/* X labels */}
        {xLabelIdx.map((i) => {
          const x =
            PAD_L +
            (labels.length === 1
              ? INNER_W / 2
              : (i * INNER_W) / (labels.length - 1));
          return (
            <text
              key={i}
              x={x}
              y={H - 6}
              textAnchor="middle"
              fontSize={9}
              fill="var(--color-muted)"
              fontFamily="var(--font-mono, monospace)"
            >
              {shortDayLabel(labels[i])}
            </text>
          );
        })}

        {/* Series */}
        <g transform={`translate(${PAD_L} ${PAD_T})`}>
          {series.map((s, si) => {
            const pts = points.get(s.key) ?? [];
            return (
              <g key={s.key}>
                {si === 0 && (
                  <path d={areaPath(pts, INNER_H)} fill={s.color} opacity={0.08} />
                )}
                <path
                  d={linePath(pts)}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={1.75}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            );
          })}

          {/* Hover crosshair + markers */}
          {hoverX !== null && (
            <g>
              <line
                x1={hoverX}
                x2={hoverX}
                y1={0}
                y2={INNER_H}
                stroke="var(--color-muted)"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              {series.map((s) => {
                const p = (points.get(s.key) ?? [])[hover ?? 0];
                return (
                  p && (
                    <circle
                      key={s.key}
                      cx={p.x}
                      cy={p.y}
                      r={3}
                      fill={s.color}
                      stroke="var(--color-surface)"
                      strokeWidth={1.5}
                    />
                  )
                );
              })}
            </g>
          )}
        </g>
      </svg>

      {/* Tooltip */}
      {hover !== null && hoverX !== null && (
        <div
          className="pointer-events-none absolute top-2 z-10 rounded-lg border border-line bg-surface px-3 py-2 shadow-lg"
          style={
            hoverX > INNER_W / 2
              ? { right: `${100 - ((PAD_L + hoverX) / W) * 100 + 2}%` }
              : { left: `${((PAD_L + hoverX) / W) * 100 + 2}%` }
          }
        >
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
            {shortDayLabel(labels[hover])}
          </div>
          <ul className="mt-1 space-y-0.5">
            {series.map((s) => (
              <li key={s.key} className="flex items-center gap-2 text-[12px]">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span className="text-muted">{s.label}</span>
                <span className="ml-auto pl-3 font-mono text-ink">
                  {formatCompact(s.values[hover] ?? 0)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Legend / empty state */}
      {hasData ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-muted">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              {s.label}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-center text-[12px] text-muted">
          No events in this window yet.
        </p>
      )}
    </div>
  );
}
