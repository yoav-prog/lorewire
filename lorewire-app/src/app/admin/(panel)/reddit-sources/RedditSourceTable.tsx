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
}: {
  rows: RedditSourceRow[];
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
          onClear={() => setSelected(new Set())}
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

function BulkFooter({
  ids,
  onClear,
}: {
  ids: string[];
  onClear: () => void;
}) {
  return (
    <div className="sticky bottom-3 z-10 mx-auto flex max-w-[760px] flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/40 bg-bg/95 px-4 py-2.5 shadow-lg backdrop-blur">
      <span className="font-mono text-[12px] text-ink">
        {ids.length.toLocaleString()} selected
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onClear}
          className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted hover:text-ink"
        >
          Clear
        </button>
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
            if (
              !window.confirm(
                `Enqueue ${ids.length} row${ids.length === 1 ? "" : "s"} for full pipeline processing (article + images + video)?\n\n` +
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
          <button
            type="submit"
            className="rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg hover:opacity-90"
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
