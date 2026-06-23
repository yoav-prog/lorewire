// Reddit candidate browse page.
//
// Three-pane layout in spirit: filter rail (left), table (centre), bulk-action
// footer (sticky, appears when N rows selected). State lives in the URL so
// every filter combination is shareable and browser-back works.
//
// Phase 2 lands the filter + browse + skip flow. The bulk "Process N" path
// — which flips selected rows to status='queued' and enqueues the pipeline
// — lands in Phase 3 alongside the worker entry.

import Link from "next/link";
import { requireCapability } from "@/lib/dal";
import {
  countRedditSources,
  listRedditSources,
  listRedditSourceSubreddits,
  type RedditSourceFilters,
  type RedditSourceOrderBy,
  type RedditSourceStatus,
  type RedditSourceStrength,
} from "@/lib/reddit-source";
import {
  formatCents,
  getBudgetSummary,
  type BudgetSummary,
} from "@/lib/story-jobs-budget";
import { setDailyBudgetCapAction } from "@/app/admin/actions";
import RedditSourceTable from "./RedditSourceTable";
import FilterRail from "./FilterRail";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const STATUS_LABEL: Record<RedditSourceStatus, string> = {
  imported: "Imported",
  queued: "Queued",
  processing: "Processing",
  used: "Used",
  skipped: "Skipped",
};

const SORT_LABEL: Record<RedditSourceOrderBy, string> = {
  "strength DESC": "Priority ↓",
  "comments DESC": "Comments ↓",
  "comments ASC": "Comments ↑",
  "length_chars DESC": "Length ↓",
  "length_chars ASC": "Length ↑",
  "date_written DESC": "Date ↓",
  "date_written ASC": "Date ↑",
  "subreddit ASC": "Subreddit A–Z",
};

// 2026-06-23 IdeasDB priority import. Mirror of the `strength` enum on
// reddit_source. 'none' rows render without a badge in the table, so
// listing it here is purely for the filter rail's "show only None"
// option (rare, but useful to confirm what's NOT been curated).
const STRENGTH_LABEL: Record<RedditSourceStrength, string> = {
  strong: "Strong",
  medium: "Medium",
  none: "None",
};

const VALID_STRENGTHS: RedditSourceStrength[] = ["strong", "medium", "none"];

interface SearchParams {
  q?: string;
  status?: string | string[];
  subreddits?: string | string[];
  strength?: string | string[];
  length_min?: string;
  length_max?: string;
  comments_min?: string;
  date_from?: string;
  date_to?: string;
  sort?: string;
  page?: string;
  // After-action flash banner params from bulk server actions.
  enqueued?: string;
  skipped_active?: string;
  reset?: string;
  cancelled?: string;
  error?: string;
  // Phase 7 budget-cap flash.
  budget_cap?: string;
}

function parseStrengths(
  v: string | string[] | undefined,
): RedditSourceStrength[] {
  const raw = toArray(v);
  return raw.filter((s): s is RedditSourceStrength =>
    (VALID_STRENGTHS as string[]).includes(s),
  );
}

function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : v.split(",").filter(Boolean);
}

function intOrUndefined(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseSort(v: string | undefined): RedditSourceOrderBy {
  if (v && v in SORT_LABEL) return v as RedditSourceOrderBy;
  return "comments DESC";
}

const VALID_STATUSES: RedditSourceStatus[] = [
  "imported",
  "queued",
  "processing",
  "used",
  "skipped",
];

function parseStatuses(v: string | string[] | undefined): RedditSourceStatus[] {
  const raw = toArray(v);
  return raw.filter((s): s is RedditSourceStatus =>
    (VALID_STATUSES as string[]).includes(s),
  );
}

export default async function RedditSourcesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireCapability("content.manage");
  const sp = await searchParams;

  const statuses = parseStatuses(sp.status);
  const subreddits = toArray(sp.subreddits);
  const strengths = parseStrengths(sp.strength);
  const sort = parseSort(sp.sort);
  const page = Math.max(intOrUndefined(sp.page) ?? 1, 1);

  // Default to status='imported' if the caller didn't pick anything — the
  // import flow lands here and the candidate pool is the natural first view.
  const effectiveStatuses =
    statuses.length > 0 ? statuses : (["imported"] as RedditSourceStatus[]);

  const filters: RedditSourceFilters = {
    status: effectiveStatuses,
    subreddits: subreddits.length > 0 ? subreddits : undefined,
    strength: strengths.length > 0 ? strengths : undefined,
    length_min: intOrUndefined(sp.length_min),
    length_max: intOrUndefined(sp.length_max),
    comments_min: intOrUndefined(sp.comments_min),
    date_from: sp.date_from || undefined,
    date_to: sp.date_to || undefined,
    search: sp.q?.trim() || undefined,
  };

  const [rows, total, allSubs, budget] = await Promise.all([
    listRedditSources(filters, {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      orderBy: sort,
    }),
    countRedditSources(filters),
    listRedditSourceSubreddits(),
    getBudgetSummary(),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
            Reddit Sources
          </h1>
          <p className="mt-1 font-mono text-[11px] text-muted">
            Candidate pool for stories.{" "}
            {total.toLocaleString()} match the current filters out of the full
            pool.
          </p>
        </div>
        <Link
          href="/admin/reddit-sources/import"
          className="rounded-lg bg-accent px-4 py-2 font-semibold text-bg transition-opacity hover:opacity-90"
        >
          Import CSV
        </Link>
      </div>

      <FlashBanner sp={sp} />

      <BudgetBar budget={budget} />

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <FilterRail
          searchParams={sp}
          activeStatuses={effectiveStatuses}
          activeSubreddits={subreddits}
          activeStrengths={strengths}
          allSubreddits={allSubs}
          sort={sort}
          validStatuses={VALID_STATUSES}
          statusLabel={STATUS_LABEL}
          validStrengths={VALID_STRENGTHS}
          strengthLabel={STRENGTH_LABEL}
          sortLabel={SORT_LABEL}
        />
        <div className="space-y-3">
          <RedditSourceTable
            rows={rows}
            budgetExhausted={budget.exhausted}
          />
          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            searchParams={sp}
          />
        </div>
      </div>
    </div>
  );
}

function BudgetBar({ budget }: { budget: BudgetSummary }) {
  // Three visual states, in order of "you should pay attention":
  //   exhausted (red)   — next click would block at the worker
  //   approaching (amber) — past 75% of cap
  //   ok (muted)        — well under cap, or no cap set
  //
  // The cap form is always present so the admin can edit without
  // navigating; empty value clears the cap.
  const hasCap = budget.capCents !== null;
  const pct = Math.round(budget.fraction * 100);
  let tone = "border-line bg-surface text-muted";
  let pillTone = "border-line text-muted";
  if (budget.exhausted) {
    tone = "border-danger/40 bg-danger/10 text-danger";
    pillTone = "border-danger/40 bg-danger/10 text-danger";
  } else if (hasCap && budget.fraction >= 0.75) {
    tone = "border-cat-entitled/40 bg-cat-entitled/10 text-cat-entitled";
    pillTone = "border-cat-entitled/40 text-cat-entitled";
  }
  const spentLabel = formatCents(budget.spentCents);
  const capLabel = hasCap ? formatCents(budget.capCents ?? 0) : "no cap";

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-2.5 ${tone}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-[11px] uppercase tracking-wider opacity-70">
          Today (UTC)
        </span>
        <span className="font-display text-[15px] font-bold">
          {spentLabel}
        </span>
        <span className="opacity-60">/</span>
        <span className="font-mono text-[12px]">{capLabel}</span>
        {hasCap && (
          <span
            className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${pillTone}`}
          >
            {pct}% used
          </span>
        )}
        {budget.actualCents > 0 && (
          // Actual billed cost (from stories.cost_cents). Only shown when
          // at least one story has the column populated, which the
          // worker now writes on every run. The projection above is the
          // safety-net the worker gate uses; this number is what the
          // run actually cost.
          <span className="rounded-full border border-cat-ok/40 bg-cat-ok/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-cat-ok">
            actual {formatCents(budget.actualCents)}
          </span>
        )}
        <span className="font-mono text-[10px] opacity-60">
          {budget.jobCount.toLocaleString()} job{budget.jobCount === 1 ? "" : "s"}{" "}
          (done today + active) · est. ~$0.50/job
        </span>
      </div>
      <form action={setDailyBudgetCapAction} className="flex items-center gap-2">
        <label className="font-mono text-[10px] uppercase tracking-wider opacity-70">
          Cap $
        </label>
        <input
          name="cap_usd"
          type="number"
          min={0}
          step="0.50"
          defaultValue={
            budget.capCents !== null ? (budget.capCents / 100).toFixed(2) : ""
          }
          placeholder="unlimited"
          className="w-24 rounded-md border border-line bg-bg px-2 py-1 font-mono text-[12px] text-ink outline-none focus:border-accent"
        />
        <button
          type="submit"
          className="rounded-md border border-line px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-muted hover:text-ink"
        >
          Save
        </button>
      </form>
    </div>
  );
}

function FlashBanner({ sp }: { sp: SearchParams }) {
  // Two banner shapes:
  //   Process N    → ?enqueued=N&skipped_active=N
  //   Re-process N → ?reset=N&skipped_active=N
  // Both shapes are flag-and-counter; we render whichever is present and
  // omit zeros so a clean run shows only the relevant numbers.
  const enqueued = Number(sp.enqueued ?? 0);
  const skippedActive = Number(sp.skipped_active ?? 0);
  const reset = Number(sp.reset ?? 0);
  const cancelled = Number(sp.cancelled ?? 0);

  if (sp.cancelled !== undefined) {
    return (
      <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
        Stopped <strong>{cancelled}</strong> in-flight row
        {cancelled === 1 ? "" : "s"}. They're back in the candidate pool as{" "}
        <code>imported</code> — queue them again when you're ready. Any spend
        already incurred by a worker mid-call is non-refundable.
      </div>
    );
  }

  if (sp.error) {
    const friendly: Record<string, string> = {
      "daily-budget-exhausted":
        "Daily budget cap exhausted — clear it or raise the cap before processing more rows.",
      "cap-must-be-positive-or-blank":
        "Cap must be greater than zero, or blank for unlimited. To halt all processing temporarily, set a tiny cap like $0.01.",
      "bad-cap-value": "Cap value must be a non-negative number.",
      "no-selection": "Select at least one row before clicking the bulk action.",
    };
    const label = friendly[sp.error] ?? sp.error.replace(/-/g, " ");
    return (
      <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
        {label}
      </div>
    );
  }
  if (sp.budget_cap !== undefined) {
    const label =
      sp.budget_cap === "cleared"
        ? "Daily budget cap cleared (unlimited)."
        : `Daily budget cap set to $${(Number(sp.budget_cap) / 100).toFixed(2)}.`;
    return (
      <div className="rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-[12px] text-accent">
        {label}
      </div>
    );
  }
  if (enqueued > 0 || (sp.enqueued !== undefined && skippedActive > 0)) {
    // 2026-06-16: banner copy now spells out who drains the queue. In
    // production the Vercel cron at /api/drain_story_jobs ticks every
    // 2 minutes; in local dev the cron doesn't fire and the admin has to
    // run the worker themselves. The page can't tell which it is from
    // here (server actions run on the same Vercel runtime), so the copy
    // surfaces BOTH options and links to the per-row timeline where the
    // admin can see for sure whether claims are landing.
    return (
      <div className="rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-[12px] text-accent">
        Enqueued <strong>{enqueued}</strong> row
        {enqueued === 1 ? "" : "s"} for processing.
        {skippedActive > 0 && (
          <>
            {" "}
            Skipped {skippedActive} that already had an active job.
          </>
        )}{" "}
        On Vercel the cron at <code>/api/drain_story_jobs</code> drains
        every 2 minutes; in local dev run{" "}
        <code className="font-mono">python -m pipeline.story_jobs_worker</code>{" "}
        from the repo root, or{" "}
        <code className="font-mono">
          npm --prefix lorewire-app run dev:drain
        </code>{" "}
        to mirror the cron. Click into any row to watch its live timeline.
      </div>
    );
  }
  if (reset > 0 || (sp.reset !== undefined && skippedActive > 0)) {
    return (
      <div className="rounded-xl border border-line bg-surface px-3 py-2 text-[12px] text-ink">
        Reset <strong>{reset}</strong> row{reset === 1 ? "" : "s"} to{" "}
        <code>imported</code>.
        {skippedActive > 0 && (
          <>
            {" "}
            Skipped {skippedActive} that were still queued or processing —
            wait for those to finish before re-processing.
          </>
        )}
      </div>
    );
  }
  return null;
}

function Pagination({
  page,
  totalPages,
  total,
  searchParams,
}: {
  page: number;
  totalPages: number;
  total: number;
  searchParams: SearchParams;
}) {
  if (totalPages <= 1) {
    return (
      <p className="text-center font-mono text-[11px] text-muted">
        {total.toLocaleString()} row{total === 1 ? "" : "s"} total
      </p>
    );
  }
  return (
    <PaginationLinks
      page={page}
      totalPages={totalPages}
      total={total}
      searchParams={searchParams}
    />
  );
}

// Preserve every filter param on the Prev/Next links — previously these
// dropped the querystring, which silently dumped the admin from "page 2
// of filtered AITAH results" to "page 1 of unfiltered everything." We
// rebuild from the SearchParams shape the page already parsed so the
// destination URL carries the full filter state minus the page key.
function buildPageHref(searchParams: SearchParams, page: number): string {
  const qs = new URLSearchParams();
  const append = (key: string, value: string | undefined) => {
    if (value !== undefined && value !== "") qs.append(key, value);
  };
  const appendMany = (key: string, value: string | string[] | undefined) => {
    if (!value) return;
    const arr = Array.isArray(value) ? value : [value];
    for (const v of arr) if (v) qs.append(key, v);
  };
  append("q", searchParams.q);
  appendMany("status", searchParams.status);
  appendMany("subreddits", searchParams.subreddits);
  appendMany("strength", searchParams.strength);
  append("length_min", searchParams.length_min);
  append("length_max", searchParams.length_max);
  append("comments_min", searchParams.comments_min);
  append("date_from", searchParams.date_from);
  append("date_to", searchParams.date_to);
  append("sort", searchParams.sort);
  qs.set("page", String(page));
  return `/admin/reddit-sources?${qs.toString()}`;
}

function PaginationLinks({
  page,
  totalPages,
  total,
  searchParams,
}: {
  page: number;
  totalPages: number;
  total: number;
  searchParams: SearchParams;
}) {
  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;
  return (
    <div className="flex items-center justify-center gap-3 font-mono text-[11px]">
      <PrevNextLink
        disabled={prevDisabled}
        href={buildPageHref(searchParams, page - 1)}
        label="← Prev"
      />
      <span className="text-muted">
        page {page} of {totalPages} · {total.toLocaleString()} row
        {total === 1 ? "" : "s"}
      </span>
      <PrevNextLink
        disabled={nextDisabled}
        href={buildPageHref(searchParams, page + 1)}
        label="Next →"
      />
    </div>
  );
}

function PrevNextLink({
  disabled,
  href,
  label,
}: {
  disabled: boolean;
  href: string;
  label: string;
}) {
  if (disabled) {
    return <span className="opacity-40">{label}</span>;
  }
  return (
    <Link href={href} className="text-accent hover:underline">
      {label}
    </Link>
  );
}
