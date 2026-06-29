"use client";

// One-shot backfill trigger on /admin/polls. Calls the
// backfillPollsAction (admin-gated, server-side) and surfaces the
// per-row counters returned. Re-runnable — the server-side action is
// idempotent (admin-saved polls stay untouched, draft fallbacks get
// upgraded when bodies have content).
//
// 2026-06-18 polls plan extension: every article must have a poll,
// existing or new.

import { useState, useTransition } from "react";
import {
  backfillPollsAction,
  type BackfillPollsResult,
} from "@/app/admin/actions";

export function BackfillButton() {
  const [running, startBackfill] = useTransition();
  const [last, setLast] = useState<BackfillPollsResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function onClick(): void {
    setErr(null);
    startBackfill(async () => {
      try {
        const r = await backfillPollsAction();
        setLast(r);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-ink">
            Backfill polls for existing content
          </p>
          <p className="mt-1 text-[12px] text-muted">
            Walks every published story and article without an
            admin-enabled poll. Tries an LLM auto-draft per row; falls
            back to a draft preset when the LLM can't produce a usable
            question. Idempotent — re-running is safe.
          </p>
        </div>
        <button
          type="button"
          onClick={onClick}
          disabled={running}
          className="rounded-md bg-accent px-4 py-1.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
        >
          {running ? "Backfilling…" : "Run backfill"}
        </button>
      </div>

      {last && (
        <dl className="mt-3 grid grid-cols-2 gap-2 font-mono text-[11px] text-muted sm:grid-cols-4">
          <Cell label="Stories scanned" value={last.storiesScanned} />
          <Cell label="Articles scanned" value={last.articlesScanned} />
          <Cell
            label="LLM polls created"
            value={last.pollsCreatedFromLLM}
            accent
          />
          <Cell
            label="Draft fallbacks"
            value={last.pollsCreatedAsDraft}
          />
          {last.errors > 0 && (
            <Cell label="Errors" value={last.errors} warn />
          )}
        </dl>
      )}

      {err && (
        <p className="mt-3 rounded-md border border-cat-entitled/40 bg-cat-entitled/10 px-3 py-2 text-[12px] text-cat-entitled">
          {err}
        </p>
      )}
    </div>
  );
}

function Cell({
  label,
  value,
  accent,
  warn,
}: {
  label: string;
  value: number;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div>
      <dt className="uppercase tracking-wider">{label}</dt>
      <dd
        className={
          warn
            ? "font-display text-[16px] font-bold text-cat-entitled"
            : accent
              ? "font-display text-[16px] font-bold text-accent"
              : "font-display text-[16px] font-bold text-ink"
        }
      >
        {value.toLocaleString()}
      </dd>
    </div>
  );
}
