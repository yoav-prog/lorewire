"use client";

// The upload form is a client component because we use useActionState to
// surface the diff summary inline without redirecting. The server action
// returns a structured result (counts + warnings) — that lets us render a
// rich after-state right on the same page.

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  syncRedditSourceCsvAction,
  type RedditSyncResult,
} from "@/app/admin/actions";

const FIELD =
  "w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";
const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";
const SECTION = "rounded-xl border border-line bg-surface p-4";
const PRIMARY_BTN =
  "rounded-lg bg-accent px-5 py-2.5 font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed";
const SECONDARY_BTN =
  "rounded-lg border border-line px-4 py-2 font-mono text-[12px] uppercase tracking-wider text-muted hover:text-ink";

export default function RedditSourceImportForm() {
  const [state, dispatch, pending] = useActionState<
    RedditSyncResult | null,
    FormData
  >(syncRedditSourceCsvAction, null);
  const [fileName, setFileName] = useState<string>("");
  const [fileSizeKb, setFileSizeKb] = useState<number | null>(null);

  return (
    <>
      <form action={dispatch} className={`${SECTION} space-y-4`}>
        <div>
          <label className={LABEL} htmlFor="csv">
            CSV file
          </label>
          <input
            id="csv"
            name="csv"
            type="file"
            accept=".csv,text/csv,application/vnd.ms-excel"
            required
            disabled={pending}
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              setFileName(f?.name ?? "");
              setFileSizeKb(f ? Math.round(f.size / 1024) : null);
            }}
            className={FIELD}
          />
          {fileName && (
            <p className="mt-1 font-mono text-[10px] text-muted">
              {fileName} · {fileSizeKb?.toLocaleString() ?? "?"} KB
            </p>
          )}
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            name="dry_run"
            value="1"
            className="accent-accent"
            disabled={pending}
          />
          Dry-run preview — compute the diff without writing anything
        </label>

        <div className="flex items-center justify-end gap-3">
          <Link href="/admin/reddit-sources" className={SECONDARY_BTN}>
            Cancel
          </Link>
          <button type="submit" disabled={pending} className={PRIMARY_BTN}>
            {pending ? "Syncing…" : "Upload and sync"}
          </button>
        </div>
      </form>

      {state && <ResultPanel state={state} />}
    </>
  );
}

function ResultPanel({ state }: { state: RedditSyncResult }) {
  if (!state.ok && state.error) {
    return (
      <div className="rounded-xl border border-danger/40 bg-danger/10 p-4 text-[13px] text-danger">
        <p className="font-semibold">Sync failed</p>
        <p className="mt-1 font-mono text-[12px]">{state.error}</p>
      </div>
    );
  }

  const stats: Array<[label: string, value: number]> = [
    ["Parsed", state.parsed ?? 0],
    ["New", state.new ?? 0],
    ["Updated", state.updated ?? 0],
    ["Unchanged", state.unchanged ?? 0],
    ["Errors", state.errors ?? 0],
  ];

  const hasWarnings = state.warnings && state.warnings.length > 0;
  const dupeCount =
    state.warnings?.filter((w) => w.includes("duplicate Reddit ID")).length ??
    0;

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-wider text-muted">
            Result · {state.apply_ms?.toLocaleString() ?? "?"} ms
          </span>
          {(state.new ?? 0) > 0 && (
            <Link
              href="/admin/reddit-sources?status=imported&sort=date_written+DESC"
              className="font-mono text-[11px] text-accent hover:underline"
            >
              View new rows →
            </Link>
          )}
        </div>
        <div className="grid grid-cols-5 gap-2">
          {stats.map(([label, value]) => (
            <div
              key={label}
              className="rounded-md border border-line bg-bg p-2 text-center"
            >
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
                {label}
              </div>
              <div className="mt-0.5 font-display text-[18px] font-bold text-ink">
                {value.toLocaleString()}
              </div>
            </div>
          ))}
        </div>

        {state.sample_new && state.sample_new.length > 0 && (
          <div className="mt-4">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted">
              First {state.sample_new.length} new
            </div>
            <div className="flex flex-wrap gap-1">
              {state.sample_new.map((rid) => (
                <span
                  key={rid}
                  className="rounded-md border border-line bg-bg px-2 py-0.5 font-mono text-[11px] text-ink"
                >
                  {rid}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {hasWarnings && (
        <details className="rounded-xl border border-cat-entitled/40 bg-cat-entitled/10 p-4">
          <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-wider text-cat-entitled">
            {state.warnings!.length.toLocaleString()} parser warning
            {state.warnings!.length === 1 ? "" : "s"}
            {dupeCount > 0 && (
              <span className="ml-2 normal-case tracking-normal text-muted">
                ({dupeCount.toLocaleString()} duplicate IDs)
              </span>
            )}
          </summary>
          <ul className="mt-3 max-h-[280px] space-y-0.5 overflow-y-auto font-mono text-[11px] text-muted">
            {state.warnings!.slice(0, 200).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
            {state.warnings!.length > 200 && (
              <li className="text-muted">
                … and {(state.warnings!.length - 200).toLocaleString()} more
              </li>
            )}
          </ul>
        </details>
      )}
    </div>
  );
}
