// Client-safe surface of the admin analytics feature: the range enum, its
// URL-param parsing, and the row shape the interactive table renders.
// Deliberately NO "server-only" import here — the "use client" components
// under app/admin/(panel)/analytics/_components import from this module,
// and pulling lib/analytics.ts (server-only, DB access) into a client
// bundle is the exact failure mode feedback_use_client_imports_server_only
// documents. lib/analytics.ts re-exports everything here for server code.

export type AnalyticsRange = 7 | 30 | 90 | "all";

/** The range chips the pages render, in display order. `param` is the
 *  ?range= URL value; keep these stable — they are shareable URLs. */
export const ANALYTICS_RANGES: ReadonlyArray<{
  range: AnalyticsRange;
  param: string;
  label: string;
}> = [
  { range: 7, param: "7", label: "7 days" },
  { range: 30, param: "30", label: "30 days" },
  { range: 90, param: "90", label: "90 days" },
  { range: "all", param: "all", label: "All time" },
];

/** Parse the ?range= search param against the closed enum; anything else
 *  (missing, garbage, arrays) falls back to 30 days. This is the only
 *  place user input approaches the analytics SQL, and it never reaches
 *  it as a string. */
export function parseAnalyticsRange(
  value: string | string[] | undefined,
): AnalyticsRange {
  const match = ANALYTICS_RANGES.find((r) => r.param === value);
  return match ? match.range : 30;
}

/** One story's engagement rollup for the selected window — the rows of
 *  the searchable performance table. Produced by getStoryPerformance in
 *  lib/analytics.ts; must stay JSON-serializable (server -> client prop). */
export interface StoryPerformanceRow {
  id: string;
  title: string;
  category: string | null;
  status: string | null;
  publishedAt: string | null;
  duration: string | null;
  thumbnail: string | null;
  plays: number;
  completions: number;
  /** completions / plays; null when there are no plays. */
  completionRate: number | null;
  viewers: number;
  votes: number;
  saves: number;
  shares: number;
  ratings: number;
  score: number;
}
