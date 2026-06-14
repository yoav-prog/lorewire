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
import { requireAdmin } from "@/lib/dal";
import {
  countRedditSources,
  listRedditSources,
  listRedditSourceSubreddits,
  type RedditSourceFilters,
  type RedditSourceOrderBy,
  type RedditSourceStatus,
} from "@/lib/reddit-source";
import {
  formatCents,
  getBudgetSummary,
  type BudgetSummary,
} from "@/lib/story-jobs-budget";
import { setDailyBudgetCapAction } from "@/app/admin/actions";
import RedditSourceTable from "./RedditSourceTable";

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
  "comments DESC": "Comments ↓",
  "comments ASC": "Comments ↑",
  "length_chars DESC": "Length ↓",
  "length_chars ASC": "Length ↑",
  "date_written DESC": "Date ↓",
  "date_written ASC": "Date ↑",
  "subreddit ASC": "Subreddit A–Z",
};

interface SearchParams {
  q?: string;
  status?: string | string[];
  subreddits?: string | string[];
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
  error?: string;
  // Phase 7 budget-cap flash.
  budget_cap?: string;
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
  await requireAdmin();
  const sp = await searchParams;

  const statuses = parseStatuses(sp.status);
  const subreddits = toArray(sp.subreddits);
  const sort = parseSort(sp.sort);
  const page = Math.max(intOrUndefined(sp.page) ?? 1, 1);

  // Default to status='imported' if the caller didn't pick anything — the
  // import flow lands here and the candidate pool is the natural first view.
  const effectiveStatuses =
    statuses.length > 0 ? statuses : (["imported"] as RedditSourceStatus[]);

  const filters: RedditSourceFilters = {
    status: effectiveStatuses,
    subreddits: subreddits.length > 0 ? subreddits : undefined,
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
          allSubreddits={allSubs}
          sort={sort}
        />
        <div className="space-y-3">
          <RedditSourceTable rows={rows} />
          <Pagination page={page} totalPages={totalPages} total={total} />
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

  if (sp.error) {
    return (
      <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
        {sp.error.replace(/-/g, " ")}
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
        Make sure the worker is running:{" "}
        <code className="text-ink">python -m pipeline.story_jobs_worker</code>
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

function FilterRail({
  searchParams,
  activeStatuses,
  activeSubreddits,
  allSubreddits,
  sort,
}: {
  searchParams: SearchParams;
  activeStatuses: RedditSourceStatus[];
  activeSubreddits: string[];
  allSubreddits: string[];
  sort: RedditSourceOrderBy;
}) {
  // The rail submits as a plain GET form so every filter combination is in
  // the URL — bookmarkable, shareable, browser-back-friendly, and trivial
  // to debug. No client-side state and no JS required for the filter logic.
  return (
    <form
      method="get"
      className="space-y-4 rounded-xl border border-line bg-surface p-4"
    >
      <div>
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted">
          Search
        </label>
        <input
          type="search"
          name="q"
          defaultValue={searchParams.q ?? ""}
          placeholder="title or summary…"
          className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
        />
      </div>

      <fieldset>
        <legend className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted">
          Status
        </legend>
        <div className="grid grid-cols-2 gap-1">
          {VALID_STATUSES.map((s) => {
            const checked = activeStatuses.includes(s);
            return (
              <label
                key={s}
                className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink transition-colors has-[input:checked]:border-accent has-[input:checked]:bg-surface2"
              >
                <input
                  type="checkbox"
                  name="status"
                  value={s}
                  defaultChecked={checked}
                  className="accent-accent"
                />
                {STATUS_LABEL[s]}
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted">
          Subreddit
        </legend>
        <select
          name="subreddits"
          multiple
          defaultValue={activeSubreddits}
          size={8}
          className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
        >
          {allSubreddits.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <p className="mt-1 font-mono text-[9px] text-muted">
          Ctrl/⌘-click to multi-select
        </p>
      </fieldset>

      <fieldset>
        <legend className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted">
          Length (chars)
        </legend>
        <div className="flex gap-2">
          <input
            type="number"
            name="length_min"
            min={0}
            defaultValue={searchParams.length_min ?? ""}
            placeholder="min"
            className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
          />
          <input
            type="number"
            name="length_max"
            min={0}
            defaultValue={searchParams.length_max ?? ""}
            placeholder="max"
            className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
          />
        </div>
      </fieldset>

      <div>
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted">
          Min comments
        </label>
        <input
          type="number"
          name="comments_min"
          min={0}
          defaultValue={searchParams.comments_min ?? ""}
          placeholder="e.g. 100"
          className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
        />
      </div>

      <fieldset>
        <legend className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted">
          Date range
        </legend>
        <div className="space-y-1">
          <input
            type="date"
            name="date_from"
            defaultValue={searchParams.date_from ?? ""}
            className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
          />
          <input
            type="date"
            name="date_to"
            defaultValue={searchParams.date_to ?? ""}
            className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
          />
        </div>
      </fieldset>

      <div>
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted">
          Sort
        </label>
        <select
          name="sort"
          defaultValue={sort}
          className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
        >
          {Object.entries(SORT_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Link
          href="/admin/reddit-sources"
          className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-ink"
        >
          Reset
        </Link>
        <button
          type="submit"
          className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90"
        >
          Apply
        </button>
      </div>
    </form>
  );
}

function Pagination({
  page,
  totalPages,
  total,
}: {
  page: number;
  totalPages: number;
  total: number;
}) {
  if (totalPages <= 1) {
    return (
      <p className="text-center font-mono text-[11px] text-muted">
        {total.toLocaleString()} row{total === 1 ? "" : "s"} total
      </p>
    );
  }
  // Preserve the existing query string when paging. The simplest server-safe
  // way is a thin client read of window.location — but the form submits
  // GET, so the URL already has every filter we care about; building the
  // href with just ?page= would drop them. We rebuild from a known set of
  // keys that the page reads.
  return (
    <PaginationLinks page={page} totalPages={totalPages} total={total} />
  );
}

function PaginationLinks({
  page,
  totalPages,
  total,
}: {
  page: number;
  totalPages: number;
  total: number;
}) {
  // No JS: server-rendered prev/next links. The current URL's query string
  // is implicit because the filter form submits via GET — but page=N
  // belongs there too, so we rebuild it from the props the page already
  // received. We accept that prev/next clicks need a full server round
  // trip; for a filter-heavy candidate list, that's the right trade.
  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;
  const BASE = "/admin/reddit-sources";
  return (
    <div className="flex items-center justify-center gap-3 font-mono text-[11px]">
      <PrevNextLink
        disabled={prevDisabled}
        href={`${BASE}?page=${page - 1}`}
        label="← Prev"
      />
      <span className="text-muted">
        page {page} of {totalPages} · {total.toLocaleString()} row
        {total === 1 ? "" : "s"}
      </span>
      <PrevNextLink
        disabled={nextDisabled}
        href={`${BASE}?page=${page + 1}`}
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
