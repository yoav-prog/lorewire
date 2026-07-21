// Pure geometry and formatting for the admin analytics charts. No React,
// no DOM, no dates-from-the-clock — everything is deterministic math so
// the SVG components in app/admin/(panel)/analytics/_components stay thin
// and this file carries the unit tests (chart-math.test.ts).

export interface ChartPoint {
  x: number;
  y: number;
}

/** Compact admin-facing numbers: 0 -> "0", 999 -> "999", 1234 -> "1.2K",
 *  1_500_000 -> "1.5M". Negative values keep their sign. Non-finite input
 *  renders as "0" so a bad aggregate can never crash a page. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  const units = [
    { value: 1e9, suffix: "B" },
    { value: 1e6, suffix: "M" },
    { value: 1e3, suffix: "K" },
  ];
  for (const u of units) {
    if (abs >= u.value) {
      const scaled = n / u.value;
      const text =
        Math.abs(scaled) >= 100
          ? String(Math.round(scaled))
          : scaled.toFixed(1).replace(/\.0$/, "");
      return `${text}${u.suffix}`;
    }
  }
  return String(Math.round(n));
}

/** 0.42 -> "42%". `null` (no data, e.g. a rate over zero plays) renders
 *  as "n/a" instead of a misleading zero. */
export function formatPercent(x: number | null, digits = 0): string {
  if (x === null || !Number.isFinite(x)) return "n/a";
  return `${(x * 100).toFixed(digits)}%`;
}

/** Percent change of `current` vs `previous`, in whole percents
 *  (12 = +12%). Returns null when there is no previous baseline to
 *  compare against, so callers render "new" instead of a fake +∞. */
export function percentChange(
  current: number,
  previous: number,
): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

/** Round a raw step up to the nearest "nice" step (1/2/5 x 10^k). */
export function niceStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  if (normalized <= 1) return magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

/** Y-axis ticks from 0 up to (at least) maxValue in nice steps. Always
 *  returns at least [0, 1] so a zero/empty chart still has a scale. */
export function niceTicks(maxValue: number, count = 4): number[] {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return [0, 1];
  const step = niceStep(maxValue / count);
  const top = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return ticks;
}

/** Map a value series onto chart coordinates. x spreads evenly across
 *  `width` (a single point centers); y grows downward from 0 (top) to
 *  `height` (bottom, value 0). `max` <= 0 pins everything to the floor. */
export function seriesPoints(
  values: number[],
  width: number,
  height: number,
  max: number,
): ChartPoint[] {
  const n = values.length;
  if (n === 0) return [];
  return values.map((v, i) => ({
    x: n === 1 ? width / 2 : (i * width) / (n - 1),
    y: max > 0 ? height - (Math.max(0, v) / max) * height : height,
  }));
}

/** SVG path ("M x y L x y ...") through the points; "" when empty. */
export function linePath(points: ChartPoint[]): string {
  if (points.length === 0) return "";
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${round2(p.x)} ${round2(p.y)}`)
    .join(" ");
}

/** Closed SVG path under the line down to y = height (for area fills). */
export function areaPath(points: ChartPoint[], height: number): string {
  if (points.length === 0) return "";
  const line = linePath(points);
  const first = points[0];
  const last = points[points.length - 1];
  return `${line} L${round2(last.x)} ${round2(height)} L${round2(first.x)} ${round2(height)} Z`;
}

/** Normalize values to fractions of their sum. Zero/negative-total input
 *  returns [] so a donut with no data renders its empty state instead of
 *  NaN arcs. Negative individual values clamp to 0. */
export function fractions(values: number[]): number[] {
  const clamped = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = clamped.reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  return clamped.map((v) => v / total);
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "2026-07-05" -> "Jul 5". Locale-independent on purpose so server and
 *  client render identical text (no hydration drift). Malformed input
 *  falls through unchanged. */
export function shortDayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return day;
  return `${month} ${Number(m[3])}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
