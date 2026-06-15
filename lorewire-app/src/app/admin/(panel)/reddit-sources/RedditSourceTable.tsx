"use client";

// Reddit source list table with multi-select and a sticky bulk-action footer.
//
// Phase 2 surfaces the Skip bulk action (mark selected rows as not-going-
// to-be-processed) so the candidate pool can be curated before any pipeline
// work happens. The Process bulk action — flip selected to status='queued'
// and enqueue stories — lands in Phase 3 next to the worker entry.
//
// Selection state lives in this component (URL state is just the filter
// view). The hidden inputs in the bulk forms re-materialize the selection
// for the server action.

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  skipRedditSourcesAction,
  reopenRedditSourcesAction,
  processRedditSourcesAction,
  bulkReprocessRedditSourcesAction,
  cancelActiveStoryJobsAction,
} from "@/app/admin/actions";
import type {
  RedditSourceRow,
  RedditSourceStatus,
} from "@/lib/reddit-source";

const STATUS_TONE: Record<RedditSourceStatus, string> = {
  imported: "border-line text-muted",
  queued: "border-accent/40 bg-accent/10 text-accent",
  processing: "border-accent/40 bg-accent/15 text-accent",
  used: "border-cat-ok/40 bg-cat-ok/10 text-cat-ok",
  skipped: "border-cat-entitled/40 bg-cat-entitled/10 text-cat-entitled",
};

export default function RedditSourceTable({
  rows,
  budgetExhausted = false,
}: {
  rows: RedditSourceRow[];
  /** When true, the Process N button is disabled with a tooltip so the
   *  admin can't enqueue rows the worker would just budget-block. The
   *  server action enforces the same gate; this is the UX mirror. */
  budgetExhausted?: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const allSelected = useMemo(
    () => rows.length > 0 && rows.every((r) => selected.has(r.reddit_id)),
    [rows, selected],
  );
  const someSelected = selected.size > 0;

  function toggleOne(rid: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(rid);
      else next.delete(rid);
      return next;
    });
  }
  function toggleAll(checked: boolean) {
    setSelected(() => {
      if (!checked) return new Set();
      return new Set(rows.map((r) => r.reddit_id));
    });
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-surface p-8 text-center">
        <p className="font-mono text-[12px] text-muted">
          No rows match these filters.
        </p>
        <Link
          href="/admin/reddit-sources/import"
          className="mt-3 inline-block font-mono text-[12px] text-accent hover:underline"
        >
          Import a CSV →
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line bg-bg">
              <Th className="w-[36px] text-center">
                <input
                  type="checkbox"
                  aria-label="Select all on this page"
                  checked={allSelected}
                  onChange={(e) => toggleAll(e.currentTarget.checked)}
                  className="accent-accent"
                />
              </Th>
              <Th>Subreddit</Th>
              <Th>Title</Th>
              <Th className="text-right">Len</Th>
              <Th className="text-right">Comments</Th>
              <Th>Date</Th>
              <Th>Status</Th>
              <Th className="text-right">Source</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const checked = selected.has(r.reddit_id);
              return (
                <tr
                  key={r.reddit_id}
                  className="border-b border-line last:border-0 hover:bg-surface2"
                >
                  <Td className="text-center">
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.reddit_id}`}
                      checked={checked}
                      onChange={(e) =>
                        toggleOne(r.reddit_id, e.currentTarget.checked)
                      }
                      className="accent-accent"
                    />
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-[11px] text-muted">
                    r/{r.subreddit}
                  </Td>
                  <Td>
                    <Link
                      href={`/admin/reddit-sources/${r.reddit_id}`}
                      className="block max-w-[420px] truncate text-ink hover:text-accent"
                    >
                      {r.title}
                    </Link>
                    {r.summary && (
                      <span className="mt-0.5 block max-w-[420px] truncate font-mono text-[10px] text-muted">
                        {r.summary}
                      </span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-right font-mono text-[11px] text-muted">
                    {r.length_chars?.toLocaleString() ?? "—"}
                  </Td>
                  <Td className="whitespace-nowrap text-right font-mono text-[11px] text-muted">
                    {r.comments?.toLocaleString() ?? "—"}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-[11px] text-muted">
                    {formatDate(r.date_written)}
                  </Td>
                  <Td>
                    <StatusChip status={r.status} />
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    {r.url ? (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="font-mono text-[11px] text-accent hover:underline"
                      >
                        open ↗
                      </a>
                    ) : (
                      <span className="font-mono text-[11px] text-muted">
                        —
                      </span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {someSelected && (
        <BulkFooter
          ids={[...selected]}
          activeIds={rows
            .filter(
              (r) =>
                selected.has(r.reddit_id) &&
                (r.status === "queued" || r.status === "processing"),
            )
            .map((r) => r.reddit_id)}
          onClear={() => setSelected(new Set())}
          budgetExhausted={budgetExhausted}
        />
      )}
    </>
  );
}

function StatusChip({ status }: { status: string }) {
  const safe = (status as RedditSourceStatus) in STATUS_TONE
    ? (status as RedditSourceStatus)
    : "imported";
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${STATUS_TONE[safe]}`}
    >
      {status}
    </span>
  );
}

// Per-batch output choice for the Process N action. '' = "use the
// reddit.default_output setting" (the worker resolves at claim time);
// 'short' / 'long' pin every row in this batch to that format and
// survive a later setting change. Kept narrow so the confirm dialog
// copy below stays exhaustive.
type OutputChoice = "" | "short" | "long";

function BulkFooter({
  ids,
  activeIds,
  onClear,
  budgetExhausted,
}: {
  ids: string[];
  /** Subset of `ids` whose row is currently queued or processing.
   *  The Stop button only appears + only submits these — there's
   *  nothing to cancel for rows that are imported / used / skipped. */
  activeIds: string[];
  onClear: () => void;
  budgetExhausted: boolean;
}) {
  // Default '' so a click that doesn't touch the picker honours the
  // admin's global default. Stored locally so the confirm dialog can
  // spell out which format will run before the credit-spend.
  const [outputChoice, setOutputChoice] = useState<OutputChoice>("");
  return (
    <div className="sticky bottom-3 z-10 mx-auto flex max-w-[760px] flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/40 bg-bg/95 px-4 py-2.5 shadow-lg backdrop-blur">
      <span className="font-mono text-[12px] text-ink">
        {ids.length.toLocaleString()} selected
        {activeIds.length > 0 && (
          <span className="ml-2 font-mono text-[10px] text-muted">
            ({activeIds.length} in flight)
          </span>
        )}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onClear}
          className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted hover:text-ink"
        >
          Clear
        </button>
        {activeIds.length > 0 && (
          <form
            action={cancelActiveStoryJobsAction}
            onSubmit={(e) => {
              // Honest confirm. The worker can't be killed mid-LLM-call
              // from the DB layer alone — we flip the status flag and
              // the worker's eventual finish() no-ops against it. So
              // LLM/image spend already incurred is non-refundable.
              if (
                !window.confirm(
                  `Cancel ${activeIds.length} in-flight row${activeIds.length === 1 ? "" : "s"}?\n\n` +
                    "What happens:\n" +
                    "  • Jobs flip to 'cancelled' immediately.\n" +
                    "  • Source rows reset to 'imported' so you can re-queue.\n" +
                    "  • Any LLM/image/voice spend ALREADY incurred by an\n" +
                    "    in-flight worker is non-refundable — the worker\n" +
                    "    keeps running its current call but the result is\n" +
                    "    discarded.\n\n" +
                    "Cost not yet spent (jobs still queued) is fully saved.",
                )
              ) {
                e.preventDefault();
              }
            }}
          >
            {activeIds.map((id) => (
              <input key={id} type="hidden" name="reddit_id" value={id} />
            ))}
            <button
              type="submit"
              title="Stop the worker from processing these rows. Saves any not-yet-spent budget."
              className="rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-danger hover:opacity-80"
            >
              Stop {activeIds.length}
            </button>
          </form>
        )}
        <form action={reopenRedditSourcesAction}>
          {ids.map((id) => (
            <input key={id} type="hidden" name="reddit_id" value={id} />
          ))}
          <button
            type="submit"
            className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted hover:text-ink"
          >
            Re-open as imported
          </button>
        </form>
        <form action={skipRedditSourcesAction}>
          {ids.map((id) => (
            <input key={id} type="hidden" name="reddit_id" value={id} />
          ))}
          <button
            type="submit"
            className="rounded-md border border-cat-entitled/40 bg-cat-entitled/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-cat-entitled hover:opacity-80"
          >
            Skip {ids.length}
          </button>
        </form>
        <form
          action={bulkReprocessRedditSourcesAction}
          onSubmit={(e) => {
            // Re-process is destructive: it archives the generated
            // story and puts the row back in the candidate pool, ready
            // to be re-enqueued via Process N. Cheap operation in
            // isolation, but a 50-row mass re-process throws away 50
            // stories the user spent real money to generate. Confirm.
            if (
              !window.confirm(
                `Archive the generated stories for ${ids.length} row${ids.length === 1 ? "" : "s"} and reset them to 'imported'?\n\n` +
                  "Only rows currently in status='used' will be reset. Rows that are still queued or processing will be skipped to avoid disrupting an in-flight worker.\n\n" +
                  "You can re-enqueue with Process N afterwards.",
              )
            ) {
              e.preventDefault();
            }
          }}
        >
          {ids.map((id) => (
            <input key={id} type="hidden" name="reddit_id" value={id} />
          ))}
          <button
            type="submit"
            className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted hover:text-ink"
          >
            Re-process {ids.length}
          </button>
        </form>
        <form
          action={processRedditSourcesAction}
          onSubmit={(e) => {
            // Lazy guard against accidental bulk-spend. The real cost is the
            // sum of LLM + kie images + voice + render across N rows; a
            // dozen rows can easily run $5+. Confirm before submit.
            const formatLine =
              outputChoice === "short"
                ? "Output: SHORT only (no long-form video render this batch)."
                : outputChoice === "long"
                  ? "Output: LONG-FORM video (skips the short pipeline)."
                  : "Output: use the global default (Settings → Reddit imports → Default output).";
            if (
              !window.confirm(
                `Enqueue ${ids.length} row${ids.length === 1 ? "" : "s"} for full pipeline processing (article + images + video)?\n\n` +
                  `${formatLine}\n\n` +
                  "Each row spends real LLM + image + voice credits. The local pipeline worker must be running:\n\n" +
                  "    python -m pipeline.story_jobs_worker",
              )
            ) {
              e.preventDefault();
            }
          }}
        >
          {ids.map((id) => (
            <input key={id} type="hidden" name="reddit_id" value={id} />
          ))}
          <input type="hidden" name="with_media" value="1" />
          {/* Closed enum: '' = "use the reddit.default_output setting".
              The server action validates the same enum, so a stale
              browser tab can't smuggle a typo through. */}
          <label className="mr-2 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted">
            Output
            <select
              name="output_format"
              value={outputChoice}
              onChange={(e) =>
                setOutputChoice(e.currentTarget.value as OutputChoice)
              }
              className="rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] normal-case tracking-normal text-ink outline-none focus:border-accent"
              aria-label="Output format for this batch"
            >
              <option value="">Default</option>
              <option value="short">Short only</option>
              <option value="long">Long-form</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={budgetExhausted}
            title={
              budgetExhausted
                ? "Daily budget exhausted — clear or raise the cap to enqueue more"
                : undefined
            }
            className="rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Process {ids.length}
          </button>
        </form>
      </div>
    </div>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-muted ${className}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 align-top ${className}`}>{children}</td>;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  // Show YYYY-MM-DD; the time of day doesn't help on a candidate list.
  return iso.slice(0, 10);
}
